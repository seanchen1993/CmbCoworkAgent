using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Windows.SDK.BuildTools.WinApp.UIAutomation;

namespace CmbNativeDesktop;

internal static class Program
{
    private static int Main(string[] arguments)
    {
        if (!OperatingSystem.IsWindows() || !Environment.Is64BitProcess) return 3;
        if (arguments.Length != 2 || arguments[0] != "--native-desktop-worker" || !Guid.TryParseExact(arguments[1], "D", out _)) return 3;
        try
        {
            Native.SetDpi();
            var worker = Native.Worker();
            Native.AssertPrivate(worker.Desktop);
            if (Thread.CurrentThread.GetApartmentState() != ApartmentState.MTA) throw new DesktopException("worker_requires_mta");
            using var session = new DesktopSession(arguments[1], worker);
            return session.Run();
        }
        catch
        {
            // stderr is deliberately a short non-sensitive diagnostic; stdout is framed JSON only.
            Console.Error.WriteLine("[CMBDevClaw] Native desktop worker could not establish its private desktop.");
            return 2;
        }
    }
}

internal sealed class DesktopSession(string nonce, WorkerIdentity worker) : IDisposable
{
    private readonly object stateGate = new();
    private readonly BlockingCollection<Incoming> requests = new(1);
    private readonly Dictionary<string, WindowIdentity> admissions = new(StringComparer.Ordinal);
    private readonly Queue<string> recentIds = new();
    private readonly HashSet<string> recentIdSet = new(StringComparer.Ordinal);
    private NativeDesktopAutomation? automation;
    private Scope? scope;
    private WindowIdentity? selected;
    private readonly HashSet<WindowIdentity> sensitiveWindows = new();
    private readonly Dictionary<WindowIdentity, long> sensitivityRetirementChecks = new();
    private IFrameGrabber? capture;
    private string? captureId;
    private FrameTicket? publishedTicket;
    private long lastCaptureRequest;
    private long lastSequence;
    private string? activeId;
    private CancellationTokenSource? activeCancellation;
    private volatile bool submitted;
    private bool completionClaimed;
    private volatile bool transportClosed;
    private bool disposed;
    private PendingLaunch? pendingLaunch;
    private string[] readRoots = [];
    private string[] writeRoots = [];
    private long lastAdmissionSequence;

    internal int Run()
    {
        Wire.Emit(new
        {
            type = "ready", protocol = Wire.Protocol, version = Wire.Version, nonce, worker,
            capabilities = new { capture = NativeDesktopAutomation.IsCaptureSupported, semanticInput = true,
                pointerInput = false, keyboardInput = false, messagePointer = true, messageDrag = true, messageKeyboard = true, messageChords = true, independentDesktopVerified = false }
        });
        var reader = new Thread(ReadRequests) { IsBackground = true, Name = "CMB native desktop framed input" };
        reader.Start();
        while (!transportClosed)
        {
            if (!requests.TryTake(out var request, 1000))
            {
                if (requests.IsCompleted) break;
                BoundedMaintenance();
                continue;
            }
            using var cancellation = new CancellationTokenSource();
            lock (stateGate) { activeId = request.Id; activeCancellation = cancellation; submitted = false; completionClaimed = false; }
            // UIA providers are synchronous COM and may ignore cooperative cancellation. A hard
            // per-operation deadline exits this worker; its external owner closes/proves the Job.
            using var watchdog = new System.Threading.Timer(_ => HardTimeout(request), null, TimeSpan.FromSeconds(12), Timeout.InfiniteTimeSpan);
            try
            {
                ValidateRequest(request);
                cancellation.Token.ThrowIfCancellationRequested();
                var result = Execute(request, cancellation.Token);
                cancellation.Token.ThrowIfCancellationRequested();
                Result(request, "ok", result);
                if (request.Operation == "close") return 0;
            }
            catch (Exception error)
            {
                var uncertain = submitted;
                Result(request, uncertain ? "unknown" : "rejected", null,
                    error is OperationCanceledException ? "cancelled" : ErrorCode(error));
                if (uncertain) return 2;
            }
            finally
            {
                lock (stateGate) { activeId = null; activeCancellation = null; }
            }
            BoundedMaintenance();
        }
        return 2;
    }
    private void ReadRequests()
    {
        try
        {
            var input = Console.OpenStandardInput();
            while (Wire.Read(input) is { } request)
            {
                if (request.Protocol != Wire.Protocol || request.Version != Wire.Version || request.Nonce != nonce)
                    throw new DesktopException("invalid_protocol");
                Wire.Identifier(request.Id, true);
                if (request.Type == "cancel")
                {
                    lock (stateGate)
                    {
                        if (request.Id != activeId || request.Scope != scope || activeCancellation is null)
                            throw new DesktopException("invalid_cancellation_scope");
                        activeCancellation.Cancel();
                    }
                    continue;
                }
                if (request.Type != "request") throw new DesktopException("invalid_frame_type");
                lock (stateGate)
                {
                    // One bounded look-ahead avoids a race when the peer receives a result and
                    // sends its next request just before the executor clears activeId.
                    if (!requests.TryAdd(request)) throw new DesktopException("request_queue_full");
                }
            }
        }
        catch
        {
            // A malformed or overflowing stream closes the physical port, rather than buffering
            // arbitrary requests or letting an unknown operation race the command executor.
            transportClosed = true;
            lock (stateGate) activeCancellation?.Cancel();
        }
        finally
        {
            transportClosed = true;
            requests.CompleteAdding();
            lock (stateGate) activeCancellation?.Cancel();
        }
    }
    private void ValidateRequest(Incoming request)
    {
        request.Scope.Validate();
        if (request.Sequence != lastSequence + 1 || request.Sequence > Wire.MaximumSafeInteger || recentIdSet.Contains(request.Id))
            throw new DesktopException("invalid_sequence");
        lastSequence = request.Sequence;
        recentIdSet.Add(request.Id); recentIds.Enqueue(request.Id);
        if (recentIds.Count > 64) recentIdSet.Remove(recentIds.Dequeue());
        if (request.Operation != "open" && request.Scope != scope) throw new DesktopException("stale_scope");
        if (request.Params.ValueKind != JsonValueKind.Object) throw new DesktopException("invalid_parameters");
    }
    private object Execute(Incoming request, CancellationToken cancellation)
    {
        Native.AssertPrivate(worker.Desktop);
        if (request.Operation == "open")
        {
            if (scope is not null || request.Window is not null) throw new DesktopException("already_open");
            ExactParameters(request.Params, "jobName", "bootId", "sessionId", "desktop", "readRoots", "writeRoots");
            if (Text(request.Params, "jobName", 128) != "Local\\CMBDevClaw-Bot-" + nonce ||
                Number(request.Params, "sessionId") != worker.SessionId || Text(request.Params, "desktop", 128) != worker.Desktop)
                throw new DesktopException("admission_identity_mismatch");
            Wire.Identifier(Text(request.Params, "bootId", 256));
            readRoots = Launch.Roots(request.Params, "readRoots");
            writeRoots = Launch.Roots(request.Params, "writeRoots");
            lock (stateGate) scope = request.Scope;
            automation = new NativeDesktopAutomation();
            return new { worker };
        }
        if (scope is null || automation is null) throw new DesktopException("not_open");
        if (request.Operation == "close")
        {
            ExactParameters(request.Params);
            Invalidate(); pendingLaunch?.Dispose(); pendingLaunch = null;
            return new { captureDisposed = true, workerClosing = true, jobEmptyProven = false };
        }
        if (request.Operation == "invalidate")
        {
            ExactParameters(request.Params, "nextGeneration");
            var generation = Text(request.Params, "nextGeneration", 36); Wire.Identifier(generation, true);
            if (generation == scope.Generation) throw new DesktopException("generation_not_rotated");
            Invalidate(); admissions.Clear(); selected = null;
            lock (stateGate) scope = scope with { Generation = generation };
            return new { observationRequired = true };
        }
        if (request.Operation is "revoke" or "grant")
        {
            ExactParameters(request.Params, "nextControlEpoch", "nextControl");
            var epoch = Number(request.Params, "nextControlEpoch");
            var control = Text(request.Params, "nextControl", 16);
            if (epoch != scope.ControlEpoch + 1 || epoch > Wire.MaximumSafeInteger ||
                control != (request.Operation == "revoke" ? "human" : "bot")) throw new DesktopException("invalid_control_transition");
            Invalidate();
            lock (stateGate) scope = scope with { ControlEpoch = epoch, Control = control };
            return new { observationRequired = true, captureDisposed = true };
        }
        if (request.Operation == "windows")
        {
            ExactParameters(request.Params);
            PruneRetiredAdmissions(cancellation);
            var windows = Native.Windows(worker, cancellation, out var truncated);
            // These are candidates only. The broker must query the EXTERNAL Job owner, filter,
            // and send admit_window before UIA or capture is ever opened for a candidate.
            return new { windows = windows.Select(item => new { window = item.Window, title = item.Title }), truncated };
        }
        if (request.Operation == "admit_window")
        {
            ExactParameters(request.Params, "ownerSequence");
            var admissionSequence = Number(request.Params, "ownerSequence");
            if (admissionSequence <= lastAdmissionSequence || admissionSequence > Wire.MaximumSafeInteger || request.Window is null)
                throw new DesktopException("invalid_window_admission");
            Native.AssertWindow(request.Window, worker);
            PruneRetiredAdmissions(cancellation);
            if (admissions.Count == 128 && !admissions.ContainsKey(request.Window.Hwnd)) throw new DesktopException("window_admission_limit");
            admissions[request.Window.Hwnd] = request.Window;
            lastAdmissionSequence = admissionSequence;
            return new { window = request.Window };
        }
        if (request.Operation == "approved_launch")
        {
            if (scope.Control != "bot" || pendingLaunch is not null) throw new DesktopException("launch_unavailable");
            var launch = Launch.Parameters(request.Params, readRoots, writeRoots);
            cancellation.ThrowIfCancellationRequested();
            submitted = true;
            pendingLaunch = Launch.StartSuspended(launch, worker);
            // Do not resume on a weak IsProcessInJob(NULL) answer. The trusted broker asks the
            // external owner about this exact PID, then sends admit_launch with unchanged ticks.
            return new { launchId = pendingLaunch.Id, process = pendingLaunch.Identity, suspended = true };
        }
        if (request.Operation == "admit_launch")
        {
            ExactParameters(request.Params, "launchId", "pid", "startTicks", "sessionId", "desktop", "ownerSequence");
            var launch = pendingLaunch ?? throw new DesktopException("launch_not_pending");
            if (Text(request.Params, "launchId", 36) != launch.Id || Number(request.Params, "pid") != launch.Identity.Pid ||
                Text(request.Params, "startTicks", 19) != launch.Identity.StartTicks || Number(request.Params, "sessionId") != worker.SessionId ||
                Text(request.Params, "desktop", 128) != worker.Desktop || Number(request.Params, "ownerSequence") <= lastAdmissionSequence)
                throw new DesktopException("stale_launch_admission");
            lastAdmissionSequence = Number(request.Params, "ownerSequence");
            cancellation.ThrowIfCancellationRequested(); submitted = true;
            launch.Resume();
            pendingLaunch = null;
            launch.Dispose();
            return new { launchId = launch.Id, process = launch.Identity, resumed = true };
        }
        if (request.Operation == "select_window")
        {
            ExactParameters(request.Params);
            var window = Admitted(request.Window);
            Invalidate(); selected = window;
            return new { window, title = Native.Title(window), observationRequired = true };
        }
        var target = Admitted(request.Window);
        if (selected != target) throw new DesktopException("window_not_selected");
        var hwnd = (nint)Wire.Hwnd(target.Hwnd);
        object result;
        switch (request.Operation)
        {
            case "observe":
                ExactParameters(request.Params);
                GuardModelRead(target, hwnd, cancellation);
                var observation = automation.Observe(hwnd, target.Pid, cancellation);
                if (observation.Elements.Any(element => element.Password)) ProtectWindow(target);
                result = new { window = target, title = Native.Title(target), elements = observation.Elements, truncated = observation.Truncated };
                break;
            case "frame":
                ExactParameters(request.Params, "issueInputTicket");
                GuardModelRead(target, hwnd, cancellation);
                var issueTicket = !request.Params.TryGetProperty("issueInputTicket", out var issue) ||
                    issue.ValueKind == JsonValueKind.True;
                if (request.Params.TryGetProperty("issueInputTicket", out issue) && issue.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                    throw new DesktopException("invalid_input_ticket_issue");
                result = Frame(target, issueTicket, cancellation);
                break;
            case "has_sensitive_input":
                ExactParameters(request.Params);
                var sensitivity = InspectSensitiveWindow(target, hwnd, cancellation);
                result = new { window = target, sensitivity.PasswordDetected, sensitivity.Complete };
                break;
            case "review_message":
                ExactParameters(request.Params, "captureId", "frameVersion", "expectedWindowTitle", "actionKind", "x", "y", "kind", "path");
                AssertMessageInputSafe(target, hwnd, cancellation);
                var messageTicket = InputTicket(request.Params, target);
                var messageKind = Text(request.Params, "actionKind", 32);
                if (messageKind == "message_keyboard" &&
                    (request.Params.TryGetProperty("x", out _) || request.Params.TryGetProperty("y", out _) ||
                     request.Params.TryGetProperty("kind", out _) || request.Params.TryGetProperty("path", out _)))
                    throw new DesktopException("invalid_window_message_action");
                var messageTarget = WindowMessages.Review(messageTicket, target, worker, messageKind,
                    messageKind == "message_pointer" ? Point(request.Params, "x") : 0,
                    messageKind == "message_pointer" ? Point(request.Params, "y") : 0,
                    ReadDragPath(request.Params));
                result = new { window = target, title = Native.Title(target), target = messageTarget };
                break;
            case "message_pointer":
                InputAllowed();
                ExactParameters(request.Params, "captureId", "frameVersion", "x", "y", "kind", "button", "delta", "path", "expectedWindowTitle", "expectedMessageTarget");
                if (scope.Control != "human") AssertMessageInputSafe(target, hwnd, cancellation);
                var pointerTicket = InputTicket(request.Params, target);
                var pointerKind = Text(request.Params, "kind", 16);
                var pointerPath = ReadDragPath(request.Params);
                var pointerButton = request.Params.TryGetProperty("button", out _) ? Text(request.Params, "button", 16) : "left";
                var pointerDelta = request.Params.TryGetProperty("delta", out _) ? Signed(request.Params, "delta", -1200, 1200) : 0;
                if (pointerKind == "drag")
                {
                    if (pointerPath is null || pointerDelta != 0) throw new DesktopException("invalid_window_drag_input");
                    result = WindowMessages.Drag(pointerTicket, target, worker, Point(request.Params, "x"), Point(request.Params, "y"),
                        pointerPath, pointerButton, MessageEvidence(request.Params),
                        () => BeforeMessageSubmission(request.Params, target, pointerTicket, cancellation), cancellation);
                }
                else
                    result = WindowMessages.Pointer(pointerTicket, target, worker, Point(request.Params, "x"), Point(request.Params, "y"),
                        pointerKind, pointerButton, pointerDelta,
                        MessageEvidence(request.Params), () => BeforeMessageSubmission(request.Params, target, pointerTicket, cancellation), cancellation);
                break;
            case "message_keyboard":
                InputAllowed();
                ExactParameters(request.Params, "captureId", "frameVersion", "key", "text", "modifiers", "expectedWindowTitle", "expectedMessageTarget");
                AssertMessageInputSafe(target, hwnd, cancellation);
                var keyboardTicket = InputTicket(request.Params, target);
                result = WindowMessages.Keyboard(keyboardTicket, target, worker,
                    request.Params.TryGetProperty("key", out _) ? Text(request.Params, "key", 32) : null,
                    request.Params.TryGetProperty("text", out _) ? Text(request.Params, "text", 4096) : null,
                    ReadKeyboardModifiers(request.Params), MessageEvidence(request.Params), focus => { AssertMessageInputSafe(target, focus, cancellation); BeforeMessageSubmission(request.Params, target, keyboardTicket, cancellation); }, cancellation);
                break;
            case "review":
                ExactParameters(request.Params, "elementId", "action");
                GuardModelRead(target, hwnd, cancellation);
                var reviewId = Text(request.Params, "elementId", 36);
                var reviewedElement = automation.Review(reviewId, cancellation);
                if (request.Params.TryGetProperty("action", out _))
                {
                    if (Text(request.Params, "action", 16) != "select_all_text") throw new DesktopException("unsupported_review_action");
                    var expectedTextElement = new NativeDesktopExpected(reviewedElement.Name, reviewedElement.ControlType,
                        reviewedElement.Value, reviewedElement.Password, reviewedElement.Enabled, reviewedElement.Offscreen);
                    result = new { window = target, title = Native.Title(target), element = reviewedElement,
                        textSelection = automation.ReviewTextSelection(reviewId, expectedTextElement, cancellation) };
                }
                else result = new { window = target, title = Native.Title(target), element = reviewedElement };
                break;
            case "secret_review":
                InputAllowed();
                if (scope.Control != "human") throw new DesktopException("secret_requires_human");
                ExactParameters(request.Params, "elementId");
                ProtectWindow(target);
                result = new { window = target, title = Native.Title(target),
                    element = automation.ReviewSecret(Text(request.Params, "elementId", 36), cancellation) };
                break;
            case "set_secret":
                InputAllowed();
                if (scope.Control != "human") throw new DesktopException("secret_requires_human");
                ExactParameters(request.Params, "elementId", "value", "expectedElement", "expectedWindowTitle");
                var secretId = Text(request.Params, "elementId", 36);
                var secretExpected = SecretEvidence(request.Params, target, secretId);
                automation.SetSecret(secretId, Text(request.Params, "value", 16000), secretExpected,
                    () => BeforeSubmission(request.Params, target, cancellation), cancellation);
                result = new { applied = true };
                break;
            case "set_value":
                GuardModelRead(target, hwnd, cancellation);
                InputAllowed(); ExactParameters(request.Params, "elementId", "value", "expectedElement", "expectedWindowTitle");
                var expectedValue = ReviewEvidence(request.Params, target);
                automation.SetValue(Text(request.Params, "elementId", 36), Text(request.Params, "value", 16384), expectedValue,
                    () => BeforeSubmission(request.Params, target, cancellation), cancellation);
                result = new { applied = true }; break;
            case "invoke":
                GuardModelRead(target, hwnd, cancellation);
                InputAllowed(); ExactParameters(request.Params, "elementId", "action", "expectedElement", "expectedWindowTitle", "expectedTextSelection");
                var action = request.Params.TryGetProperty("action", out _) ? Text(request.Params, "action", 16) : "invoke";
                var invoke = action switch { "invoke" => UiInvokeAction.Invoke, "select" => UiInvokeAction.Select, "toggle" => UiInvokeAction.Toggle,
                    "expand" => UiInvokeAction.Expand, "collapse" => UiInvokeAction.Collapse, "select_all_text" => UiInvokeAction.SelectAllText, _ => throw new DesktopException("unsupported_invoke_action") };
                NativeDesktopTextSelection? expectedSelection = null;
                if (invoke == UiInvokeAction.SelectAllText) expectedSelection = TextSelectionEvidence(request.Params);
                else if (request.Params.TryGetProperty("expectedTextSelection", out _)) throw new DesktopException("unsupported_invoke_action");
                automation.Invoke(Text(request.Params, "elementId", 36), invoke, ReviewEvidence(request.Params, target), expectedSelection,
                    () => BeforeSubmission(request.Params, target, cancellation), cancellation);
                if (invoke == UiInvokeAction.SelectAllText)
                    result = new { applied = true, submitted = true, transport = "uia-text-range", effectVerified = false };
                else result = new { applied = true };
                break;
            case "scroll":
                GuardModelRead(target, hwnd, cancellation);
                InputAllowed(); ExactParameters(request.Params, "elementId", "direction", "amount", "expectedElement", "expectedWindowTitle");
                var amount = Text(request.Params, "amount", 16);
                if (amount is not ("small" or "large")) throw new DesktopException("invalid_scroll_amount");
                automation.Scroll(Text(request.Params, "elementId", 36), Text(request.Params, "direction", 16), amount == "large", ReviewEvidence(request.Params, target), () => BeforeSubmission(request.Params, target, cancellation), cancellation);
                result = new { applied = true }; break;
            default: throw new DesktopException("unknown_operation");
        }
        // If a side effect was submitted before this fails, the response is unknown and the
        // physical worker closes. No fallback or retry re-targets another window/control.
        cancellation.ThrowIfCancellationRequested(); Native.AssertWindow(target, worker);
        return result;
    }
    private void ProtectWindow(WindowIdentity window)
    {
        if (sensitiveWindows.Count >= 128 && !sensitiveWindows.Contains(window))
            throw new DesktopException("sensitive_window_limit");
        sensitiveWindows.Add(window);
    }
    private NativeDesktopSensitivity InspectSensitiveWindow(WindowIdentity window, nint hwnd, CancellationToken cancellation)
    {
        // Bound repeated preview/Teach checks. Neither a role change nor IsPassword=false
        // clears protection: only exact-window retirement or complete raw-provider absence.
        if (sensitiveWindows.Contains(window))
        {
            // A focused child can detect sensitivity, never prove retirement of a root.
            if (hwnd != (nint)Wire.Hwnd(window.Hwnd)) return new(true, false);
            var now = Environment.TickCount64;
            if (sensitivityRetirementChecks.TryGetValue(window, out var prior) && now - prior < 1000)
                return new(true, false);
            sensitivityRetirementChecks[window] = now;
            if (!automation!.TryRetireSensitiveWindow(hwnd, window.Pid, cancellation)) return new(true, false);
            Native.AssertWindow(window, worker);
            sensitiveWindows.Remove(window);
            sensitivityRetirementChecks.Remove(window);
            Invalidate(); // A confidential cached WGC image/input ticket cannot survive retirement.
        }
        var sensitivity = automation!.HasSensitiveInput(hwnd, window.Pid, cancellation, (nint)Wire.Hwnd(window.Hwnd));
        if (sensitivity.PasswordDetected) ProtectWindow(window);
        return sensitivity;
    }
    private void GuardModelRead(WindowIdentity window, nint hwnd, CancellationToken cancellation)
    {
        if (scope!.Control == "human") return;
        var sensitivity = InspectSensitiveWindow(window, hwnd, cancellation);
        if (sensitivity.PasswordDetected || !sensitivity.Complete)
            throw new DesktopException("native_sensitive_window");
    }
    private void PruneRetiredAdmissions(CancellationToken cancellation)
    {
        foreach (var admission in admissions.Values.ToArray())
        {
            cancellation.ThrowIfCancellationRequested();
            if (!Native.WindowIdentityRetired(admission)) continue;
            admissions.Remove(admission.Hwnd);
            sensitiveWindows.Remove(admission);
            sensitivityRetirementChecks.Remove(admission);
            automation?.ForgetSensitiveWindow((nint)Wire.Hwnd(admission.Hwnd), admission.Pid);
            if (selected == admission) { Invalidate(); selected = null; }
        }
    }
    private WindowIdentity Admitted(WindowIdentity? requested)
    {
        if (requested is null || !admissions.TryGetValue(requested.Hwnd, out var admitted) || requested != admitted)
            throw new DesktopException("window_not_admitted");
        Native.AssertWindow(requested, worker);
        return requested;
    }
    private void InputAllowed()
    {
        if (scope?.Control is not ("bot" or "human")) throw new DesktopException("input_control_unavailable");
    }
    private object Frame(WindowIdentity window, bool issueInputTicket, CancellationToken cancellation)
    {
        if (capture is null)
        {
            capture = automation!.StartCapture((nint)Wire.Hwnd(window.Hwnd));
            captureId = Guid.NewGuid().ToString("D");
        }
        lastCaptureRequest = Environment.TickCount64;
        var wait = Stopwatch.StartNew();
        (byte[] Pixels, int Width, int Height, long Version)? frame;
        while ((frame = capture.TryGetLatest()) is null)
        {
            cancellation.ThrowIfCancellationRequested();
            if (capture.IsClosed) { Invalidate(); throw new DesktopException("capture_closed"); }
            if (wait.ElapsedMilliseconds >= 4000) { Invalidate(); throw new DesktopException("capture_no_frame"); }
            Thread.Sleep(25);
        }
        if (capture.IsClosed) { Invalidate(); throw new DesktopException("capture_closed"); }
        var data = frame.Value;
        if (data.Width <= 0 || data.Height <= 0 || (long)data.Width * data.Height > 8294400 || data.Pixels.Length != checked(data.Width * data.Height * 4))
        { Invalidate(); throw new DesktopException("capture_size_invalid"); }
        using var image = new Bitmap(data.Width, data.Height, PixelFormat.Format32bppArgb);
        var bits = image.LockBits(new Rectangle(0, 0, data.Width, data.Height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        try
        {
            for (var row = 0; row < data.Height; row++) Marshal.Copy(data.Pixels, row * data.Width * 4,
                nint.Add(bits.Scan0, row * bits.Stride), data.Width * 4);
        }
        finally { image.UnlockBits(bits); }
        var scale = Math.Min(1d, Math.Min(1280d / data.Width, 960d / data.Height));
        var width = Math.Max(1, (int)Math.Round(data.Width * scale));
        var height = Math.Max(1, (int)Math.Round(data.Height * scale));
        using var preview = new Bitmap(width, height, PixelFormat.Format24bppRgb);
        using (var graphics = Graphics.FromImage(preview))
        { graphics.InterpolationMode = InterpolationMode.HighQualityBilinear; graphics.DrawImage(image, 0, 0, width, height); }
        using var output = new MemoryStream();
        var jpeg = ImageCodecInfo.GetImageEncoders().Single(codec => codec.FormatID == ImageFormat.Jpeg.Guid);
        using var parameters = new EncoderParameters(1);
        parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 82L);
        preview.Save(output, jpeg, parameters);
        if (output.Length > 2 * 1024 * 1024) throw new DesktopException("encoded_frame_too_large");
        cancellation.ThrowIfCancellationRequested(); Native.AssertWindow(window, worker);
        var geometry = WindowMessages.Geometry(window, data.Width, data.Height);
        if (issueInputTicket)
            publishedTicket = new(captureId!, Wire.CanonicalLong(data.Version), data.Width, data.Height, window, geometry);
        return new { window, title = Native.Title(window), width, height, sourceWidth = data.Width, sourceHeight = data.Height,
            inputTicketIssued = issueInputTicket, messageGeometryReady = geometry is not null,
            image = "data:image/jpeg;base64," + Convert.ToBase64String(output.GetBuffer(), 0, (int)output.Length),
            captureId, frameVersion = Wire.CanonicalLong(data.Version) };
    }
    private void Invalidate()
    {
        capture?.Dispose(); capture = null; captureId = null; publishedTicket = null;
        automation?.Invalidate();
    }
    private void BoundedMaintenance()
    {
        // Native GPU disposal cannot be thread-aborted safely. Bound idle cleanup as well as
        // ordinary commands so a pathological callback never leaves an immortal worker.
        using var deadline = new System.Threading.Timer(_ => Environment.Exit(124), null, TimeSpan.FromSeconds(12), Timeout.InfiniteTimeSpan);
        ReleaseIdleCapture(); ExpirePendingLaunch();
    }
    private void ReleaseIdleCapture()
    {
        if (capture is not null && Environment.TickCount64 - lastCaptureRequest >= 10000)
        {
            // GPU/frame buffers may idle out while a human reviews an action. Keep only
            // the already published identity/geometry ticket; a newly published frame
            // or a selection/control/generation change replaces or revokes it.
            capture.Dispose(); capture = null; captureId = null;
        }
    }
    private void ExpirePendingLaunch()
    {
        if (pendingLaunch is not null && Environment.TickCount64 - pendingLaunch.CreatedAt >= 10000)
        { pendingLaunch.Dispose(); pendingLaunch = null; }
    }
    private void HardTimeout(Incoming request)
    {
        // stdout emission could itself block if the peer stops reading; it must not defeat
        // the finite operation lifetime. An EOF also means unknown for a submitted mutation.
        bool emit;
        lock (stateGate)
        {
            if (activeId != request.Id) return;
            emit = !completionClaimed;
            completionClaimed = true;
        }
        if (emit)
        {
            var emitter = new Thread(() => { try { EmitResult(request, submitted ? "unknown" : "rejected", null, "native_timeout"); } catch { } }) { IsBackground = true };
            emitter.Start(); emitter.Join(100);
        }
        Environment.Exit(124);
    }
    private void Result(Incoming request, string status, object? result, string? code = null)
    {
        lock (stateGate)
        {
            if (completionClaimed) return;
            completionClaimed = true;
        }
        EmitResult(request, status, result, code);
    }
    private void EmitResult(Incoming request, string status, object? result, string? code = null) => Wire.Emit(new
    { type = "result", protocol = Wire.Protocol, version = Wire.Version, request.Id, request.Sequence, nonce, scope = scope ?? request.Scope, status, result, code });
    private FrameTicket InputTicket(JsonElement parameters, WindowIdentity target)
    {
        var ticket = publishedTicket;
        if (ticket is null || ticket.Window != target || Text(parameters, "captureId", 36) != ticket.CaptureId ||
            Text(parameters, "frameVersion", 19) != ticket.FrameVersion) throw new DesktopException("published_frame_ticket_stale");
        WindowMessages.CheckTicket(ticket, target, worker);
        if (Text(parameters, "expectedWindowTitle", 4096) != Native.Title(target)) throw new DesktopException("window_review_changed");
        return ticket;
    }
    private void BeforeMessageSubmission(JsonElement parameters, WindowIdentity target, FrameTicket expected, CancellationToken cancellation)
    {
        // Sensitivity checks may retire the old provider tree and invalidate its image.
        // A local reference does not preserve authority after publishedTicket is cleared.
        if (!ReferenceEquals(InputTicket(parameters, target), expected))
            throw new DesktopException("published_frame_ticket_stale");
        BeforeSubmission(parameters, target, cancellation);
    }
    private MessageTarget? MessageEvidence(JsonElement parameters)
    {
        if (!parameters.TryGetProperty("expectedMessageTarget", out var value))
        {
            if (scope?.Control == "bot") throw new DesktopException("window_message_review_required");
            return null; // Human input keeps its exact displayed-frame/client binding.
        }
        ExactParameters(value, "targetHwnd", "geometry", "thread", "dragClient");
        if (!value.TryGetProperty("geometry", out var geometry)) throw new DesktopException("invalid_message_review");
        ExactParameters(geometry, "left", "top", "width", "height", "clientLeft", "clientTop", "clientWidth", "clientHeight");
        if (value.TryGetProperty("dragClient", out var client))
            ExactParameters(client, "left", "top", "width", "height");
        var reviewed = value.Deserialize<MessageTarget>(Wire.Json) ?? throw new DesktopException("invalid_message_review");
        Wire.Hwnd(reviewed.TargetHwnd);
        if (reviewed.Geometry is null || reviewed.Thread == 0) throw new DesktopException("invalid_message_review");
        return reviewed;
    }
    private static string[]? ReadKeyboardModifiers(JsonElement parameters)
    {
        if (!parameters.TryGetProperty("modifiers", out var value)) return null;
        if (value.ValueKind != JsonValueKind.Array || value.GetArrayLength() is < 1 or > 3)
            throw new DesktopException("invalid_window_keyboard_modifiers");
        string[] names = ["Control", "Shift", "Alt"];
        var result = new string[value.GetArrayLength()];
        var previous = -1;
        var index = 0;
        foreach (var item in value.EnumerateArray())
        {
            var name = item.ValueKind == JsonValueKind.String ? item.GetString() : null;
            var order = Array.IndexOf(names, name);
            if (order <= previous) throw new DesktopException("invalid_window_keyboard_modifiers");
            result[index++] = name!; previous = order;
        }
        return result;
    }
    private static List<DragPoint>? ReadDragPath(JsonElement parameters)
    {
        var drag = parameters.TryGetProperty("kind", out var kind) && kind.ValueKind == JsonValueKind.String && kind.GetString() == "drag";
        if (!parameters.TryGetProperty("path", out var path))
        {
            if (drag) throw new DesktopException("invalid_window_drag_input");
            return null;
        }
        if (!drag || path.ValueKind != JsonValueKind.Array || path.GetArrayLength() is < 2 or > 32)
            throw new DesktopException("invalid_window_drag_input");
        var points = new List<DragPoint>(path.GetArrayLength());
        foreach (var point in path.EnumerateArray())
        {
            ExactParameters(point, "x", "y");
            points.Add(new(Signed(point, "x", 0, 4095), Signed(point, "y", 0, 4095)));
        }
        if (points[0].X != Point(parameters, "x") || points[0].Y != Point(parameters, "y"))
            throw new DesktopException("invalid_window_drag_input");
        return points;
    }
    private static int Point(JsonElement parameters, string name)
    {
        if (!parameters.TryGetProperty(name, out var value) || !value.TryGetDouble(out var number) || !double.IsFinite(number) ||
            number < 0 || number > 4095) throw new DesktopException("invalid_input_coordinate");
        return checked((int)Math.Round(number));
    }
    private static int Signed(JsonElement parameters, string name, int minimum, int maximum)
    {
        if (!parameters.TryGetProperty(name, out var value) || !value.TryGetInt32(out var number) || number < minimum || number > maximum)
            throw new DesktopException("invalid_signed_parameter");
        return number;
    }
    private void AssertMessageInputSafe(WindowIdentity target, nint hwnd, CancellationToken cancellation)
    {
        // Initial message admission checks the whole selected window. Keyboard batches
        // re-check the already verified exact focused child (never the global UIA focus).
        var sensitive = InspectSensitiveWindow(target, hwnd, cancellation);
        if (sensitive.PasswordDetected || !sensitive.Complete)
            throw new DesktopException("window_message_sensitive_input");
        Native.AssertWindow(target, worker);
    }
    private void BeforeSubmission(JsonElement parameters, WindowIdentity target, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        Native.AssertWindow(target, worker);
        if (Text(parameters, "expectedWindowTitle", 4096) != Native.Title(target)) throw new DesktopException("window_review_changed");
        submitted = true;
    }
    private static NativeDesktopExpected ReviewEvidence(JsonElement parameters, WindowIdentity target)
    {
        if (Text(parameters, "expectedWindowTitle", 4096) != Native.Title(target)) throw new DesktopException("window_review_changed");
        if (!parameters.TryGetProperty("expectedElement", out var element) || element.ValueKind != JsonValueKind.Object)
            throw new DesktopException("element_review_required");
        ExactParameters(element, "name", "controlType", "value", "password", "enabled", "offscreen");
        string? NullableText(string name, int maximum)
        {
            if (!element.TryGetProperty(name, out var value)) throw new DesktopException("element_review_required");
            return value.ValueKind == JsonValueKind.Null ? null : Text(element, name, maximum);
        }
        bool Boolean(string name)
        {
            if (!element.TryGetProperty(name, out var value) || value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                throw new DesktopException("element_review_required");
            return value.GetBoolean();
        }
        return new(NullableText("name", 1024), Text(element, "controlType", 128), NullableText("value", 4096),
            Boolean("password"), Boolean("enabled"), Boolean("offscreen"));
    }
    private static NativeDesktopTextSelection TextSelectionEvidence(JsonElement parameters)
    {
        if (!parameters.TryGetProperty("expectedTextSelection", out var value) || value.ValueKind != JsonValueKind.Object)
            throw new DesktopException("text_selection_review_required");
        ExactParameters(value, "token", "textSha256", "utf16Length");
        var evidence = value.Deserialize<NativeDesktopTextSelection>(Wire.Json) ?? throw new DesktopException("text_selection_review_required");
        if (!Guid.TryParseExact(evidence.Token, "D", out _) || evidence.TextSha256 is null || evidence.TextSha256.Length != 64 ||
            evidence.TextSha256.Any(character => character is not (>= '0' and <= '9' or >= 'a' and <= 'f')) ||
            evidence.Utf16Length is < 0 or > 4096) throw new DesktopException("text_selection_review_required");
        return evidence;
    }
    private static NativeDesktopSecretElement SecretEvidence(JsonElement parameters, WindowIdentity target, string elementId)
    {
        if (Text(parameters, "expectedWindowTitle", 4096) != Native.Title(target)) throw new DesktopException("window_review_changed");
        if (!parameters.TryGetProperty("expectedElement", out var element) || element.ValueKind != JsonValueKind.Object)
            throw new DesktopException("secret_review_required");
        ExactParameters(element, "id", "name", "controlType", "password", "enabled", "offscreen");
        var expected = element.Deserialize<NativeDesktopSecretElement>(Wire.Json) ?? throw new DesktopException("secret_review_required");
        if (expected.Id != elementId || !expected.Password || !expected.Enabled || expected.Offscreen ||
            expected.Name?.Length > 1024 || string.IsNullOrEmpty(expected.ControlType) || expected.ControlType.Length > 128)
            throw new DesktopException("secret_review_required");
        return expected;
    }
    private static string ErrorCode(Exception error)
    {
        if (error is DesktopException) return error.Message;
        return error.Message is "stale_element" or "element_disabled" or "password_control_requires_human" or "unsupported_value_pattern" or
            "value_read_only" or "unsupported_invoke_action" or "unsupported_invoke_pattern" or "invalid_scroll_direction" or
            "unsupported_scroll_pattern" or "unsupported_scroll_direction" or "capture_size_limit" or "uia_root_unavailable" or
            "element_review_changed" or "element_review_too_large" or "password_control_changed" or "sensitive_provider_limit" or
            "text_selection_evidence_unavailable" or "unsupported_text_selection_pattern" or "text_selection_provider_changed" or
            "text_selection_value_mismatch" or "text_selection_review_changed" or "text_selection_review_limit" or "text_selection_review_required"
            ? error.Message : "native_operation_failed";
    }
    private static void ExactParameters(JsonElement parameters, params string[] allowed)
    {
        var names = new HashSet<string>(allowed, StringComparer.Ordinal);
        foreach (var parameter in parameters.EnumerateObject()) if (!names.Contains(parameter.Name)) throw new DesktopException("unknown_parameter");
    }
    private static string Text(JsonElement parameters, string name, int maximum)
    {
        if (!parameters.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String || value.GetString() is not { } text ||
            text.Length > maximum || text.Contains('\0')) throw new DesktopException("invalid_text_parameter");
        return text;
    }
    private static long Number(JsonElement parameters, string name)
    {
        if (!parameters.TryGetProperty(name, out var value) || !value.TryGetInt64(out var number) || number < 0 || number > Wire.MaximumSafeInteger)
            throw new DesktopException("invalid_number_parameter");
        return number;
    }
    public void Dispose()
    {
        if (disposed) return; disposed = true;
        using var deadline = new System.Threading.Timer(_ => Environment.Exit(124), null, TimeSpan.FromSeconds(12), Timeout.InfiniteTimeSpan);
        Invalidate(); pendingLaunch?.Dispose(); automation?.Dispose();
        // The background reader can still be blocked inside the inherited pipe. Do not dispose
        // its bounded collection underneath its finally block; process exit reclaims the reader.
    }
}
