// HWND keyboard message encoding/newline normalization adapted from Microsoft
// WinAppCli Input/KeyboardInput.cs at 3fd590017806562f088e6b275302610b9937674b (MIT).
// This omits SendInput, global focus, modifier-state and fallback paths; optional
// HWND chord messages remain a separately advertised, unverified-effect transport.
using System.Runtime.InteropServices;
using System.Runtime.ExceptionServices;
using System.Text.Json.Serialization;

namespace CmbNativeDesktop;

internal sealed record FrameTicket(string CaptureId, string FrameVersion, int Width, int Height,
    WindowIdentity Window, MessageGeometry? Geometry);
internal sealed record MessageGeometry(int Left, int Top, int Width, int Height, int ClientLeft, int ClientTop,
    int ClientWidth, int ClientHeight);
internal sealed record DragPoint(int X, int Y);
internal sealed record DragClientGeometry(int Left, int Top, int Width, int Height);
internal sealed record MessageTarget(string TargetHwnd, MessageGeometry Geometry, uint Thread,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] DragClientGeometry? DragClient = null);
internal sealed record MessageResult(string Transport, bool Accepted, bool Processed, bool EffectVerified, string TargetHwnd, int Messages);

internal static class WindowMessages
{
    [StructLayout(LayoutKind.Sequential)] private struct Point { internal int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct Rect { internal int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct GuiThreadInfo
    {
        internal uint Size, Flags;
        internal nint Active, Focus, Capture, MenuOwner, MoveSize, Caret;
        internal Rect CaretRect;
    }
    [DllImport("user32.dll", SetLastError = true)] private static extern bool GetWindowRect(nint window, out Rect rectangle);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool GetClientRect(nint window, out Rect rectangle);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool ClientToScreen(nint window, ref Point point);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool ScreenToClient(nint window, ref Point point);
    [DllImport("user32.dll", SetLastError = true)] private static extern nint ChildWindowFromPointEx(nint parent, Point point, uint flags);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(nint window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(nint window);
    [DllImport("user32.dll")] private static extern nint GetAncestor(nint window, uint flag);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint window, out uint pid);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool GetGUIThreadInfo(uint threadId, ref GuiThreadInfo info);
    [DllImport("user32.dll")] private static extern nint GetKeyboardLayout(uint threadId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern uint MapVirtualKeyExW(uint code, uint kind, nint layout);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool PostMessageW(nint window, uint message, nuint wparam, nint lparam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint SendMessageTimeoutW(nint window,
        uint message, nuint wparam, nint lparam, uint flags, uint timeout, out nuint result);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(nint window, uint attribute, out Rect rect, uint bytes);

    internal static MessageGeometry? Geometry(WindowIdentity window, int sourceWidth, int sourceHeight)
    {
        var hwnd = (nint)Wire.Hwnd(window.Hwnd);
        Rect captureBounds;
        var dwm = DwmGetWindowAttribute(hwnd, 9, out var extended, (uint)Marshal.SizeOf<Rect>());
        if (dwm >= 0 && Match(extended, sourceWidth, sourceHeight)) captureBounds = extended;
        else if (GetWindowRect(hwnd, out var outer) && Match(outer, sourceWidth, sourceHeight)) captureBounds = outer;
        else return null;
        if (!GetClientRect(hwnd, out var client)) return null;
        var clientOrigin = new Point();
        if (!ClientToScreen(hwnd, ref clientOrigin)) return null;
        if (client.Right <= client.Left || client.Bottom <= client.Top) return null;
        return new(captureBounds.Left, captureBounds.Top, sourceWidth, sourceHeight, clientOrigin.X, clientOrigin.Y,
            client.Right - client.Left, client.Bottom - client.Top);
    }
    private static bool Match(Rect rectangle, int width, int height) => rectangle.Right - rectangle.Left == width && rectangle.Bottom - rectangle.Top == height;
    internal static void CheckTicket(FrameTicket ticket, WindowIdentity target, WorkerIdentity worker)
    {
        if (ticket.Window != target || ticket.Geometry is null) throw new DesktopException("window_message_geometry_unavailable");
        Native.AssertWindow(target, worker);
        if (Geometry(target, ticket.Width, ticket.Height) != ticket.Geometry) throw new DesktopException("window_message_geometry_changed");
    }
    private static void CheckChildIdentity(nint child, WindowIdentity target, WorkerIdentity worker)
    {
        if (child == 0 || GetAncestor(child, 2) != (nint)Wire.Hwnd(target.Hwnd)) throw new DesktopException("input_child_outside_window");
        var identity = Native.Identity(child);
        if (identity.Pid != target.Pid || identity.StartTicks != target.StartTicks || identity.SessionId != worker.SessionId ||
            identity.Desktop != worker.Desktop) throw new DesktopException("input_child_owner_changed");
    }
    private static void CheckChild(nint child, WindowIdentity target, WorkerIdentity worker)
    {
        CheckChildIdentity(child, target, worker);
        if (!IsWindowEnabled(child) || !IsWindowVisible(child)) throw new DesktopException("input_child_unavailable");
    }
    private static (nint Child, Point ClientPoint, Point ScreenPoint) Hit(FrameTicket ticket, WindowIdentity target, WorkerIdentity worker, int x, int y)
    {
        CheckTicket(ticket, target, worker);
        var geometry = ticket.Geometry!;
        if (x < 0 || x >= ticket.Width || y < 0 || y >= ticket.Height) throw new DesktopException("input_point_outside_frame");
        var screen = new Point { X = checked(geometry.Left + x), Y = checked(geometry.Top + y) };
        // Only client content is routed. Non-client caption/resize/system-menu gestures need a
        // separate verified operation; faking desktop cursor state is never a fallback.
        if (screen.X < geometry.ClientLeft || screen.X >= checked(geometry.ClientLeft + geometry.ClientWidth) ||
            screen.Y < geometry.ClientTop || screen.Y >= checked(geometry.ClientTop + geometry.ClientHeight))
            throw new DesktopException("non_client_input_unsupported");
        var current = (nint)Wire.Hwnd(target.Hwnd);
        var point = screen;
        if (!ScreenToClient(current, ref point)) throw new DesktopException("input_point_conversion_failed");
        for (var depth = 0; depth < 16; depth++)
        {
            // Skip invisible, disabled and transparent children. Windowless controls keep the
            // exact host HWND; there is no global WindowFromPoint/foreground target resolver.
            var child = ChildWindowFromPointEx(current, point, 1 | 2 | 4);
            if (child == 0 || child == current) { CheckChild(current, target, worker); return (current, point, screen); }
            CheckChild(child, target, worker);
            current = child; point = screen;
            if (!ScreenToClient(current, ref point)) throw new DesktopException("input_point_conversion_failed");
        }
        throw new DesktopException("input_child_depth_limit");
    }
    internal static MessageTarget Review(FrameTicket ticket, WindowIdentity target, WorkerIdentity worker,
        string actionKind, int x = 0, int y = 0, IReadOnlyList<DragPoint>? path = null)
    {
        CheckTicket(ticket, target, worker);
        nint child; uint thread;
        if (actionKind == "message_pointer")
        {
            child = Hit(ticket, target, worker, x, y).Child;
            thread = GetWindowThreadProcessId(child, out var pid);
            if (thread == 0 || pid != target.Pid) throw new DesktopException("input_child_owner_changed");
        }
        else if (actionKind == "message_keyboard")
        {
            var focus = Focused(target, worker); child = focus.Child; thread = focus.Thread;
        }
        else throw new DesktopException("invalid_window_message_action");
        if (path is not null)
        {
            if (actionKind != "message_pointer") throw new DesktopException("invalid_window_drag_input");
            PrepareDrag(ticket, target, worker, x, y, path, child);
        }
        return new(Wire.CanonicalLong(child.ToInt64()), ticket.Geometry!, thread,
            path is null ? null : ChildClient(child));
    }
    private static void AssertReview(FrameTicket ticket, WindowIdentity target, WorkerIdentity worker,
        MessageTarget? expected, string actionKind, int x = 0, int y = 0)
    {
        if (expected is not null && Review(ticket, target, worker, actionKind, x, y) != expected)
            throw new DesktopException("window_message_review_changed");
    }
    private static nint Packed(Point point)
    {
        if (point.X < short.MinValue || point.X > short.MaxValue || point.Y < short.MinValue || point.Y > short.MaxValue)
            throw new DesktopException("input_message_coordinate_limit");
        return (nint)(int)(unchecked((uint)(ushort)point.X) | unchecked((uint)(ushort)point.Y) << 16);
    }
    private static DragClientGeometry ChildClient(nint child)
    {
        if (!GetClientRect(child, out var bounds) || bounds.Right <= bounds.Left || bounds.Bottom <= bounds.Top)
            throw new DesktopException("window_drag_client_unavailable");
        var origin = new Point();
        if (!ClientToScreen(child, ref origin)) throw new DesktopException("window_drag_client_unavailable");
        return new(origin.X, origin.Y, bounds.Right - bounds.Left, bounds.Bottom - bounds.Top);
    }
    private static Point[] PrepareDrag(FrameTicket ticket, WindowIdentity target, WorkerIdentity worker,
        int x, int y, IReadOnlyList<DragPoint> path, nint child)
    {
        if (path.Count is < 2 or > 32 || path[0].X != x || path[0].Y != y)
            throw new DesktopException("invalid_window_drag_input");
        var geometry = ticket.Geometry!;
        var positions = new Point[path.Count];
        for (var index = 0; index < path.Count; index++)
        {
            var step = path[index];
            if (step.X < 0 || step.X >= ticket.Width || step.Y < 0 || step.Y >= ticket.Height)
                throw new DesktopException("input_point_outside_frame");
            var screen = new Point { X = checked(geometry.Left + step.X), Y = checked(geometry.Top + step.Y) };
            if (screen.X < geometry.ClientLeft || screen.X >= checked(geometry.ClientLeft + geometry.ClientWidth) ||
                screen.Y < geometry.ClientTop || screen.Y >= checked(geometry.ClientTop + geometry.ClientHeight))
                throw new DesktopException("non_client_input_unsupported");
            // A drag stays on its original child, like capture routing. It does not
            // retarget to whichever sibling happens to be under each later point.
            if (!ScreenToClient(child, ref screen)) throw new DesktopException("input_point_conversion_failed");
            Packed(screen);
            positions[index] = screen;
        }
        CheckChild(child, target, worker); CheckTicket(ticket, target, worker);
        return positions;
    }
    internal static MessageResult Drag(FrameTicket ticket, WindowIdentity target, WorkerIdentity worker,
        int x, int y, IReadOnlyList<DragPoint> path, string button, MessageTarget? expected,
        Action beforeSubmission, CancellationToken cancellation)
    {
        if (button is not ("left" or "right")) throw new DesktopException("invalid_window_drag_input");
        var review = Review(ticket, target, worker, "message_pointer", x, y, path);
        if (expected is not null && expected != review) throw new DesktopException("window_message_review_changed");
        var child = (nint)Wire.Hwnd(review.TargetHwnd);
        var positions = PrepareDrag(ticket, target, worker, x, y, path, child);
        var down = button == "left" ? 0x201U : 0x204U;
        var up = button == "left" ? 0x202U : 0x205U;
        var flag = button == "left" ? 1U : 2U;
        var messages = 0;
        var last = positions[0];
        var downAttempted = false;
        Exception? primaryFailure = null;
        Exception? releaseFailure = null;
        void Send(uint message, nuint wparam, Point position)
        {
            cancellation.ThrowIfCancellationRequested(); CheckTicket(ticket, target, worker); CheckChild(child, target, worker);
            if (GetWindowThreadProcessId(child, out var pid) != review.Thread || pid != target.Pid || ChildClient(child) != review.DragClient)
                throw new DesktopException("window_message_review_changed");
            beforeSubmission();
            if (message == down) downAttempted = true; // Even a timeout may have delivered the down.
            if (SendMessageTimeoutW(child, message, wparam, Packed(position), 0x2 | 0x20, 150, out _) == 0)
                throw new DesktopException("window_drag_delivery_unknown");
            messages++; last = position;
        }
        void ReleaseOriginal()
        {
            // Cleanup may run after cancellation or geometry drift. Recheck only the
            // original identity/thread; never grant control or resolve a new target.
            Native.AssertWindow(target, worker); CheckChildIdentity(child, target, worker);
            if (GetWindowThreadProcessId(child, out var pid) != review.Thread || pid != target.Pid)
                throw new DesktopException("window_drag_release_target_changed");
            if (SendMessageTimeoutW(child, up, 0, Packed(last), 0x2 | 0x20, 150, out _) == 0)
                throw new DesktopException("window_drag_release_unknown");
            messages++;
        }
        try
        {
            Send(0x200, 0, positions[0]);
            Send(down, flag, positions[0]);
            for (var index = 1; index < positions.Length; index++)
            {
                if (cancellation.WaitHandle.WaitOne(10)) cancellation.ThrowIfCancellationRequested();
                Send(0x200, flag, positions[index]);
            }
        }
        catch (Exception error) { primaryFailure = error; }
        finally
        {
            if (downAttempted)
            {
                try { ReleaseOriginal(); }
                catch (Exception error) { releaseFailure = error; }
            }
        }
        // Keep the first failure and its original stack. The worker reports unknown
        // once submitted; a failed cleanup never overwrites that failure or retries input.
        if (primaryFailure is not null)
        {
            if (releaseFailure is not null) primaryFailure.Data["native_drag_release_failure"] = releaseFailure.GetType().Name;
            ExceptionDispatchInfo.Capture(primaryFailure).Throw();
        }
        if (releaseFailure is not null) ExceptionDispatchInfo.Capture(releaseFailure).Throw();
        return new("window-messages", true, true, false, review.TargetHwnd, messages);
    }
    internal static MessageResult Pointer(FrameTicket ticket, WindowIdentity target, WorkerIdentity worker, int x, int y,
        string kind, string button, int delta, MessageTarget? expected,
        Action beforeSubmission, CancellationToken cancellation)
    {
        if (kind is not ("click" or "double_click" or "move" or "wheel") || button is not ("left" or "right") || delta < -1200 || delta > 1200)
            throw new DesktopException("invalid_window_pointer_input");
        AssertReview(ticket, target, worker, expected, "message_pointer", x, y);
        var hit = Hit(ticket, target, worker, x, y);
        var clientPoint = Packed(hit.ClientPoint); var screenPoint = Packed(hit.ScreenPoint);
        var count = 0;
        void Send(uint message, nuint wparam, nint lparam)
        {
            cancellation.ThrowIfCancellationRequested(); CheckChild(hit.Child, target, worker); CheckTicket(ticket, target, worker);
            AssertReview(ticket, target, worker, expected, "message_pointer", x, y);
            beforeSubmission();
            if (SendMessageTimeoutW(hit.Child, message, wparam, lparam, 0x2 | 0x20, 500, out _) == 0)
                throw new DesktopException("window_pointer_delivery_unknown");
            count++;
        }
        Send(0x200, 0, clientPoint); // WM_MOUSEMOVE
        if (kind == "wheel")
        {
            Send(0x20A, unchecked((nuint)((uint)(ushort)(short)delta << 16)), screenPoint); // WM_MOUSEWHEEL
        }
        else if (kind is "click" or "double_click")
        {
            var down = button == "left" ? 0x201U : 0x204U;
            var up = button == "left" ? 0x202U : 0x205U;
            var flag = button == "left" ? 1U : 2U;
            Send(down, flag, clientPoint); Send(up, 0, clientPoint);
            if (kind == "double_click")
            {
                // Explicit DBLCLK message, not an OS pointer timing guess.
                Send(button == "left" ? 0x203U : 0x206U, flag, clientPoint); Send(up, 0, clientPoint);
            }
        }
        return new("window-messages", true, true, false, Wire.CanonicalLong(hit.Child.ToInt64()), count);
    }
    private static (nint Child, uint Thread) Focused(WindowIdentity target, WorkerIdentity worker)
    {
        var thread = GetWindowThreadProcessId((nint)Wire.Hwnd(target.Hwnd), out var pid);
        if (thread == 0 || pid != target.Pid) throw new DesktopException("input_window_thread_changed");
        var info = new GuiThreadInfo { Size = (uint)Marshal.SizeOf<GuiThreadInfo>() };
        if (!GetGUIThreadInfo(thread, ref info) || info.Focus == 0) throw new DesktopException("window_message_focus_unavailable");
        CheckChild(info.Focus, target, worker);
        return (info.Focus, thread);
    }
    internal static MessageResult Keyboard(FrameTicket ticket, WindowIdentity target, WorkerIdentity worker, string? key, string? text,
        IReadOnlyList<string>? modifiers, MessageTarget? expected, Action<nint> beforeSubmission, CancellationToken cancellation)
    {
        if ((key is null) == (text is null) || (text is not null && !WindowKeyboardSequence.ValidText(text)) ||
            (modifiers is not null && (key is null || modifiers.Count is < 1 or > 3)))
            throw new DesktopException("invalid_window_keyboard_input");
        string[] modifierNames = ["Control", "Shift", "Alt"];
        var lastModifier = -1;
        foreach (var modifier in modifiers ?? [])
        {
            var order = Array.IndexOf(modifierNames, modifier);
            if (order <= lastModifier) throw new DesktopException("invalid_window_keyboard_modifiers");
            lastModifier = order;
        }
        if (modifiers?.Contains("Alt") == true && (key is "Tab" or "Escape" || key == "Delete" && modifiers.Contains("Control")))
            throw new DesktopException("window_message_system_key_unsupported");
        CheckTicket(ticket, target, worker);
        AssertReview(ticket, target, worker, expected, "message_keyboard");
        var focus = Focused(target, worker);
        var count = 0;
        void BeforeBatch()
        {
            cancellation.ThrowIfCancellationRequested(); CheckTicket(ticket, target, worker);
            if (Focused(target, worker) != focus) throw new DesktopException("window_message_focus_changed");
            AssertReview(ticket, target, worker, expected, "message_keyboard");
            beforeSubmission(focus.Child);
        }
        void Post(uint message, nuint wparam, nint lparam)
        {
            cancellation.ThrowIfCancellationRequested();
            // Keep the exact handle/root/PID check per message, while the more expensive process
            // start-time / full geometry / title checks run for each bounded 16-character batch.
            if (GetWindowThreadProcessId(focus.Child, out var pid) == 0 || pid != target.Pid ||
                GetAncestor(focus.Child, 2) != (nint)Wire.Hwnd(target.Hwnd)) throw new DesktopException("input_child_owner_changed");
            if (!PostMessageW(focus.Child, message, wparam, lparam)) throw new DesktopException("window_keyboard_delivery_unknown");
            count++;
        }
        if (key is not null)
        {
            var childThread = GetWindowThreadProcessId(focus.Child, out var childPid);
            if (childThread == 0 || childPid != target.Pid) throw new DesktopException("input_child_owner_changed");
            var layout = GetKeyboardLayout(childThread);
            var system = modifiers?.Contains("Alt") == true;
            var strokes = new List<WindowKeyboardStroke>((modifiers?.Count ?? 0) + 1);
            foreach (var modifier in modifiers ?? [])
            {
                var vk = modifier switch { "Control" => 0x11U, "Shift" => 0x10U, "Alt" => 0x12U, _ => throw new DesktopException("invalid_window_keyboard_modifiers") };
                strokes.Add(Stroke(vk, false, false));
            }
            var (mainVk, extended) = key switch
            {
                "Enter" => (0x0DU, false), "Tab" => (0x09U, false), "Escape" => (0x1BU, false),
                "Backspace" => (0x08U, false), "Space" => (0x20U, false),
                "Insert" => (0x2DU, true), "Delete" => (0x2EU, true),
                "ArrowLeft" => (0x25U, true), "ArrowUp" => (0x26U, true), "ArrowRight" => (0x27U, true), "ArrowDown" => (0x28U, true),
                "Home" => (0x24U, true), "End" => (0x23U, true), "PageUp" => (0x21U, true), "PageDown" => (0x22U, true),
                "F1" => (0x70U, false), "F2" => (0x71U, false), "F3" => (0x72U, false), "F4" => (0x73U, false),
                "F5" => (0x74U, false), "F6" => (0x75U, false), "F7" => (0x76U, false), "F8" => (0x77U, false),
                "F9" => (0x78U, false), "F10" => (0x79U, false), "F11" => (0x7AU, false), "F12" => (0x7BU, false),
                _ when modifiers is not null && key.Length == 1 && (key[0] is >= 'A' and <= 'Z' or >= '0' and <= '9') => ((uint)key[0], false),
                _ => throw new DesktopException("window_message_key_unsupported")
            };
            strokes.Add(Stroke(mainVk, extended, system));
            WindowKeyboardStroke Stroke(uint vk, bool isExtended, bool isSystem)
            {
                var scan = MapVirtualKeyExW(vk, 4, layout) & 0xFF;
                if (scan == 0) throw new DesktopException("window_message_key_mapping_unavailable");
                return new(vk, isExtended, scan, isSystem);
            }
            void Down(WindowKeyboardStroke stroke)
            {
                BeforeBatch(); // Current control/frame/focus/sensitivity before every submitted down.
                CheckChild(focus.Child, target, worker);
                if (GetWindowThreadProcessId(focus.Child, out var pid) != childThread || pid != target.Pid)
                    throw new DesktopException("input_child_owner_changed");
                Post(stroke.SystemKey ? 0x104U : 0x100U, stroke.VirtualKey,
                    (nint)(int)BuildKeyLParam(false, stroke.Extended, stroke.Scan, stroke.SystemKey));
            }
            void ReleaseOriginal(WindowKeyboardStroke stroke)
            {
                // Cancellation, focus or geometry drift may require cleanup. Validate only
                // this original HWND/process/thread/desktop, never resolve a new destination.
                Native.AssertWindow(target, worker); CheckChildIdentity(focus.Child, target, worker);
                if (GetWindowThreadProcessId(focus.Child, out var pid) != childThread || pid != target.Pid)
                    throw new DesktopException("window_keyboard_release_target_changed");
                if (!PostMessageW(focus.Child, stroke.SystemKey ? 0x105U : 0x101U, stroke.VirtualKey,
                    (nint)(int)BuildKeyLParam(true, stroke.Extended, stroke.Scan, stroke.SystemKey)))
                    throw new DesktopException("window_keyboard_release_unknown");
                count++;
            }
            WindowKeyboardSequence.Deliver(strokes, Down, ReleaseOriginal);
            // A cancellation immediately after the final down is reported only after
            // original-target cleanup, so a cancelled operation cannot return success.
            cancellation.ThrowIfCancellationRequested();
        }
        else
        {
            var normalized = NormalizeNewlines(text!);
            for (var index = 0; index < normalized.Length; index++)
            {
                if (index % 16 == 0)
                {
                    if (index > 0) { cancellation.ThrowIfCancellationRequested(); Thread.Sleep(15); }
                    BeforeBatch();
                }
                Post(0x102, normalized[index], 1); // WM_CHAR, literal UTF16; no IME/keyboard state claims.
            }
        }
        // PostMessage accepted the target queue, not proof that the app handled/committed it.
        return new("window-messages", true, false, false, Wire.CanonicalLong(focus.Child.ToInt64()), count);
    }
    // Pinned WinApp encoding; ALT context is limited to WM_SYSKEY messages, never physical state.
    internal static uint BuildKeyLParam(bool keyUp, bool extended, uint scan, bool systemKey = false)
        => WindowKeyboardSequence.BuildKeyLParam(keyUp, extended, scan, systemKey);
    internal static string NormalizeNewlines(string text) => text.IndexOf('\n') < 0 ? text : text.Replace("\r\n", "\r", StringComparison.Ordinal).Replace('\n', '\r');
}
