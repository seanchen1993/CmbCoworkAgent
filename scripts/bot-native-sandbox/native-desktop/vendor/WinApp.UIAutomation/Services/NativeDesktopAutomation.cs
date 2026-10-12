// CMB exact-window adapter over pinned Microsoft WinAppCli source (MIT).
// It does not expose UiAutomationService's foreground, pointer, keyboard, ancestor,
// fuzzy-selector or ValueSetter fallback mechanisms.
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using Windows.Win32.UI.Accessibility;

namespace Microsoft.Windows.SDK.BuildTools.WinApp.UIAutomation;

/// <summary>A bounded observation of one explicitly admitted native window.</summary>
/// <param name="Elements">At most 256 exact live provider references, exposed as opaque tokens.</param>
/// <param name="Truncated">Whether the depth, element, or time bound stopped traversal.</param>
public sealed record NativeDesktopObservation(NativeDesktopElement[] Elements, bool Truncated);

/// <summary>A serializable accessible control; its id is valid only in the current observation.</summary>
/// <param name="Id">Opaque exact-provider token.</param>
/// <param name="Name">Bounded accessible name.</param>
/// <param name="ControlType">Official UIA control type.</param>
/// <param name="Value">Bounded current value, never read for a password control.</param>
/// <param name="Password">Whether UIA marks the control as protected.</param>
/// <param name="SupportedActions">Only explicitly supported semantic patterns.</param>
/// <param name="Enabled">Whether the provider currently accepts input.</param>
/// <param name="Offscreen">Whether UIA reports the control off screen.</param>
/// <param name="Depth">Depth from the explicitly admitted window root.</param>
/// <param name="ValueTruncated">Whether a bounded observation omitted part of an oversized value.</param>
public sealed record NativeDesktopElement(string Id, string? Name, string ControlType, string? Value,
    bool Password, string[] SupportedActions, bool Enabled, bool Offscreen, int Depth, bool ValueTruncated);

/// <summary>Read-only bounded credential-field evidence. No values or provider tokens are returned.</summary>
/// <param name="PasswordDetected">Whether a visible protected field was proved present.</param>
/// <param name="Complete">Whether every reachable control within the window was checked.</param>
public sealed record NativeDesktopSensitivity(bool PasswordDetected, bool Complete);

/// <summary>Exact approval evidence compared again on the retained provider before submission.</summary>
/// <param name="Name">Complete accessible name seen at review.</param>
/// <param name="ControlType">Official UIA control type seen at review.</param>
/// <param name="Value">Complete non-secret value seen at review.</param>
/// <param name="Password">Protected-field state seen at review.</param>
/// <param name="Enabled">Input-enabled state seen at review.</param>
/// <param name="Offscreen">Off-screen state seen at review.</param>
public sealed record NativeDesktopExpected(string? Name, string ControlType, string? Value, bool Password, bool Enabled, bool Offscreen);

/// <summary>Evidence for one original, bounded TextPattern document range.</summary>
/// <param name="Token">Opaque retained-range token, valid only in the current observation.</param>
/// <param name="TextSha256">SHA256 of the complete non-secret document text encoded as UTF16LE.</param>
/// <param name="Utf16Length">Exact complete text length, at most 4096 UTF16 code units.</param>
public sealed record NativeDesktopTextSelection(string Token, string TextSha256, int Utf16Length);

/// <summary>Protected destination evidence. No Value property exists in this DTO.</summary>
/// <param name="Id">Exact retained provider token.</param>
/// <param name="Name">Complete bounded accessible name.</param>
/// <param name="ControlType">Official control type.</param>
/// <param name="Password">Must remain protected before and after submission.</param>
/// <param name="Enabled">Must remain enabled.</param>
/// <param name="Offscreen">Must remain on screen.</param>
public sealed record NativeDesktopSecretElement(string Id, string? Name, string ControlType, bool Password, bool Enabled, bool Offscreen);

/// <summary>Exact, bounded UIA and WGC operations for a trusted desktop worker.</summary>
public sealed class NativeDesktopAutomation : IDisposable
{
    private readonly NativeDesktopAutomationCore service = new();
    private bool disposed;

    /// <summary>Walk only this HWND, retaining one bounded observation's exact providers.</summary>
    public NativeDesktopObservation Observe(nint hwnd, int pid, CancellationToken cancellation)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        return service.NativeDesktopObserve(hwnd, pid, cancellation);
    }
    /// <summary>Check protected controls without changing current semantic references.</summary>
    public NativeDesktopSensitivity HasSensitiveInput(nint hwnd, int pid, CancellationToken cancellation, nint? protectedWindow = null)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        return service.NativeDesktopHasSensitiveInput(hwnd, pid, protectedWindow ?? hwnd, cancellation);
    }
    /// <summary>Read complete bounded approval evidence from one retained provider, without rebinding.</summary>
    public NativeDesktopElement Review(string elementId, CancellationToken cancellation)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        return service.NativeDesktopReview(elementId, cancellation);
    }
    /// <summary>Verify the same provider's complete Value and TextPattern range before selecting text.</summary>
    public NativeDesktopTextSelection ReviewTextSelection(string elementId, NativeDesktopExpected expected, CancellationToken cancellation)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        return service.NativeDesktopReviewTextSelection(elementId, expected, cancellation);
    }
    /// <summary>Review only password metadata and writable ValuePattern availability; never read Value.</summary>
    public NativeDesktopSecretElement ReviewSecret(string elementId, CancellationToken cancellation)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        return service.NativeDesktopSecretReview(elementId, cancellation);
    }
    /// <summary>Fill one exact protected provider for a trusted human, without reading or returning its value.</summary>
    public void SetSecret(string elementId, string value, NativeDesktopSecretElement expected, Action beforeSubmission, CancellationToken cancellation)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        service.NativeDesktopSetSecret(elementId, value, expected, beforeSubmission, cancellation);
    }
    /// <summary>Replace text through one exact ValuePattern; there is no alternate mechanism.</summary>
    public void SetValue(string elementId, string value, NativeDesktopExpected expected, Action beforeSubmission, CancellationToken cancellation)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        service.NativeDesktopSetValue(elementId, value, expected, beforeSubmission, cancellation);
    }
    /// <summary>Perform one specified pattern on one exact retained provider.</summary>
    public void Invoke(string elementId, UiInvokeAction action, NativeDesktopExpected expected, NativeDesktopTextSelection? textSelection, Action beforeSubmission, CancellationToken cancellation)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        service.NativeDesktopInvoke(elementId, action, expected, textSelection, beforeSubmission, cancellation);
    }
    /// <summary>Scroll through one exact ScrollPattern; there is no pointer or wheel injection.</summary>
    public void Scroll(string elementId, string direction, bool large, NativeDesktopExpected expected, Action beforeSubmission, CancellationToken cancellation)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        service.NativeDesktopScroll(elementId, direction, large, expected, beforeSubmission, cancellation);
    }
    /// <summary>Retire a sensitive scope only when a complete bounded raw tree proves every original provider absent.</summary>
    public bool TryRetireSensitiveWindow(nint hwnd, int pid, CancellationToken cancellation)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        return service.NativeDesktopTryRetireSensitiveWindow(hwnd, pid, cancellation);
    }
    /// <summary>Retire protected references only after the worker proved their exact native window retired.</summary>
    public void ForgetSensitiveWindow(nint hwnd, int pid) => service.NativeDesktopForgetSensitiveWindow(hwnd, pid);
    /// <summary>Open one persistent HWND WGC session at two CPU readbacks per second.</summary>
    public IFrameGrabber StartCapture(nint hwnd)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        return WgcCapture.StartGrabber(new global::Windows.Win32.Foundation.HWND(hwnd), NullLogger.Instance, 2);
    }
    /// <summary>Report whether this Windows installation supports WGC, without a fallback.</summary>
    public static bool IsCaptureSupported => WgcCapture.IsSupported();
    /// <summary>Invalidate all exact provider tokens on selection or control-generation changes.</summary>
    public void Invalidate() => service.NativeDesktopClear();
    /// <summary>Release retained UIA providers and the service's COM automation instance.</summary>
    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        service.NativeDesktopClear();
        service.NativeDesktopDispose();
    }
}

internal sealed class NativeDesktopAutomationCore
{
    private readonly IUIAutomation _automation = NativeDesktopComOwnership.CreateAutomation();
    private const int NativeDesktopElementLimit = 256;
    private const int NativeDesktopDepthLimit = 6;
    private readonly Dictionary<string, IUIAutomationElement> nativeDesktopElements = new(StringComparer.Ordinal);
    private sealed record TextSelectionReview(NativeDesktopTextSelection Evidence, IUIAutomationTextRange Range);
    private readonly Dictionary<string, TextSelectionReview> textSelectionReviews = new(StringComparer.Ordinal);
    private const int TextSelectionReviewLimit = 8;
    private int nativeDesktopPid;
    private nint nativeDesktopHwnd;
    private sealed record ProtectedProvider(IUIAutomationElement Element, nint Hwnd, int Pid);
    private readonly List<ProtectedProvider> protectedProviders = new(16);
    private bool NativeDesktopIsProtectedReference(IUIAutomationElement element) =>
        protectedProviders.Any(item => ReferenceEquals(item.Element, element));
    private bool NativeDesktopIsProtected(IUIAutomationElement element)
    {
        foreach (var item in protectedProviders)
            if ((bool)_automation.CompareElements(item.Element, element)) return true;
        return false;
    }
    private void NativeDesktopProtect(IUIAutomationElement element, nint hwnd, int pid)
    {
        for (var index = 0; index < protectedProviders.Count; index++)
        {
            var item = protectedProviders[index];
            if (!(bool)_automation.CompareElements(item.Element, element)) continue;
            protectedProviders[index] = item with { Hwnd = hwnd, Pid = pid };
            return;
        }
        if (protectedProviders.Count == 16) throw new InvalidOperationException("sensitive_provider_limit");
        protectedProviders.Add(new(element, hwnd, pid));
    }
    internal void NativeDesktopForgetSensitiveWindow(nint hwnd, int pid)
    {
        for (var index = protectedProviders.Count - 1; index >= 0; index--)
        {
            var item = protectedProviders[index];
            if (item.Hwnd != hwnd || item.Pid != pid) continue;
            protectedProviders.RemoveAt(index);
            if (!nativeDesktopElements.Values.Any(element => ReferenceEquals(element, item.Element)))
                NativeDesktopComOwnership.Release(item.Element);
        }
    }

    internal bool NativeDesktopTryRetireSensitiveWindow(nint hwnd, int pid, CancellationToken cancellation)
    {
        var original = protectedProviders.Where(item => item.Hwnd == hwnd && item.Pid == pid).ToArray();
        // A missing retained identity is uncertainty, never evidence of retirement.
        if (original.Length == 0) return false;
        var next = new Queue<(IUIAutomationElement Element, int Depth)>();
        IUIAutomationTreeWalker? walker = null;
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var complete = true;
        var visited = 0;
        try
        {
            var root = _automation.ElementFromHandle(new global::Windows.Win32.Foundation.HWND(hwnd));
            if (root is null) return false;
            next.Enqueue((root, 0));
            // ControlView excludes providers. Only the full RawView can prove absence.
            walker = _automation.get_RawViewWalker();
            while (next.TryDequeue(out var item))
            {
                try
                {
                    cancellation.ThrowIfCancellationRequested();
                    if (visited++ >= NativeDesktopElementLimit || watch.ElapsedMilliseconds >= 2000) return false;
                    var element = item.Element;
                    if (element.get_CurrentProcessId() != pid) { complete = false; continue; }
                    // IsPassword=false, visibility and control generation are not retirement.
                    // CompareElements failures escape to the conservative rejection below.
                    if (element.get_CurrentIsPassword()) return false;
                    foreach (var retained in original)
                        if ((bool)_automation.CompareElements(retained.Element, element)) return false;
                    var child = walker.GetFirstChildElement(element);
                    if (item.Depth == NativeDesktopDepthLimit)
                    {
                        if (child is not null) { complete = false; NativeDesktopComOwnership.Release(child); }
                        continue;
                    }
                    while (child is not null)
                    {
                        if (visited + next.Count >= NativeDesktopElementLimit || watch.ElapsedMilliseconds >= 2000)
                        { complete = false; NativeDesktopComOwnership.Release(child); break; }
                        next.Enqueue((child, item.Depth + 1));
                        child = walker.GetNextSiblingElement(child);
                    }
                }
                finally
                {
                    if (!NativeDesktopIsProtectedReference(item.Element)) NativeDesktopComOwnership.Release(item.Element);
                }
            }
            if (!complete || watch.ElapsedMilliseconds >= 2000) return false;
            cancellation.ThrowIfCancellationRequested();
            // Both the old semantic tokens and protected references retire together.
            NativeDesktopClear();
            NativeDesktopForgetSensitiveWindow(hwnd, pid);
            return true;
        }
        catch (COMException) { return false; }
        finally
        {
            foreach (var item in next)
                if (!NativeDesktopIsProtectedReference(item.Element)) NativeDesktopComOwnership.Release(item.Element);
            NativeDesktopComOwnership.Release(walker);
        }
    }

    internal NativeDesktopSensitivity NativeDesktopHasSensitiveInput(nint hwnd, int pid, nint protectedWindow, CancellationToken cancellation)
    {
        // Independent walk ownership: never NativeDesktopClear, never retain/replace the
        // existing observation's providers. Read only PID/password/offscreen properties.
        var next = new Queue<(IUIAutomationElement Element, int Depth)>();
        IUIAutomationTreeWalker? walker = null;
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var complete = true;
        var visited = 0;
        try
        {
            var root = _automation.ElementFromHandle(new global::Windows.Win32.Foundation.HWND(hwnd));
            if (root is null) return new(false, false);
            next.Enqueue((root, 0));
            walker = _automation.get_ControlViewWalker();
            while (next.TryDequeue(out var item))
            {
                try
                {
                    cancellation.ThrowIfCancellationRequested();
                    if (visited++ >= NativeDesktopElementLimit || watch.ElapsedMilliseconds >= 2000) return new(false, false);
                    var element = item.Element;
                    if (element.get_CurrentProcessId() != pid) { complete = false; continue; }
                    if ((bool)element.get_CurrentIsPassword() && !(bool)element.get_CurrentIsOffscreen())
                    {
                        NativeDesktopProtect(element, protectedWindow, pid);
                        return new(true, false);
                    }
                    var child = walker.GetFirstChildElement(element);
                    if (item.Depth == NativeDesktopDepthLimit)
                    {
                        if (child is not null) { complete = false; NativeDesktopComOwnership.Release(child); }
                        continue;
                    }
                    while (child is not null)
                    {
                        if (visited + next.Count >= NativeDesktopElementLimit || watch.ElapsedMilliseconds >= 2000)
                        { complete = false; NativeDesktopComOwnership.Release(child); break; }
                        next.Enqueue((child, item.Depth + 1));
                        // If the provider fails during sibling acquisition, the enqueued
                        // reference is still released by finally; no transient list is lost.
                        child = walker.GetNextSiblingElement(child);
                    }
                }
                finally
                {
                    if (!NativeDesktopIsProtectedReference(item.Element)) NativeDesktopComOwnership.Release(item.Element);
                }
            }
            return new(false, complete);
        }
        catch (COMException) { return new(false, false); }
        finally
        {
            foreach (var item in next)
                if (!NativeDesktopIsProtectedReference(item.Element)) NativeDesktopComOwnership.Release(item.Element);
            NativeDesktopComOwnership.Release(walker);
        }
    }

    internal NativeDesktopObservation NativeDesktopObserve(nint hwnd, int pid, CancellationToken cancellation)
    {
        NativeDesktopClear();
        IUIAutomationTreeWalker? walker = null;
        var next = new Stack<(IUIAutomationElement Element, int Depth)>();
        var result = new List<NativeDesktopElement>(NativeDesktopElementLimit);
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var truncated = false;
        nativeDesktopPid = pid;
        nativeDesktopHwnd = hwnd;
        try
        {
            var root = _automation.ElementFromHandle(new global::Windows.Win32.Foundation.HWND(hwnd))
                ?? throw new InvalidOperationException("uia_root_unavailable");
            // Pending owns root before walker acquisition can fail.
            next.Push((root, 0));
            walker = _automation.get_ControlViewWalker();
            while (next.TryPop(out var item))
            {
                var retained = false;
                try
                {
                    cancellation.ThrowIfCancellationRequested();
                    if (result.Count == NativeDesktopElementLimit || watch.ElapsedMilliseconds >= 4000)
                    { truncated = true; break; }
                    var element = item.Element;
                    // Cross-process WebView providers remain the separate browser route.
                    if (element.get_CurrentProcessId() != pid) continue;
                    var id = Guid.NewGuid().ToString("D");
                    nativeDesktopElements.Add(id, element);
                    retained = true;
                    result.Add(NativeDesktopRead(element, id, item.Depth, complete: false));
                    if (item.Depth == NativeDesktopDepthLimit)
                    {
                        var hiddenChild = walker.GetFirstChildElement(element);
                        if (hiddenChild is not null)
                        { truncated = true; NativeDesktopComOwnership.Release(hiddenChild); }
                        continue;
                    }
                    // A transient list preserves original depth-first order. Until transferred
                    // to pending, it owns each child even if a later sibling call/cancellation fails.
                    var children = new List<IUIAutomationElement>();
                    IUIAutomationElement? child = null;
                    try
                    {
                        child = walker.GetFirstChildElement(element);
                        while (child is not null)
                        {
                            cancellation.ThrowIfCancellationRequested();
                            if (children.Count + next.Count + result.Count >= NativeDesktopElementLimit || watch.ElapsedMilliseconds >= 4000)
                            { truncated = true; break; }
                            children.Add(child);
                            var previous = child;
                            child = null;
                            child = walker.GetNextSiblingElement(previous);
                        }
                        for (var index = children.Count - 1; index >= 0; index--)
                            next.Push((children[index], item.Depth + 1));
                        children.Clear();
                    }
                    finally
                    {
                        NativeDesktopComOwnership.Release(child);
                        foreach (var pendingChild in children) NativeDesktopComOwnership.Release(pendingChild);
                    }
                }
                finally
                {
                    if (!retained && !NativeDesktopIsProtectedReference(item.Element))
                        NativeDesktopComOwnership.Release(item.Element);
                }
            }
            return new(result.ToArray(), truncated);
        }
        catch { NativeDesktopClear(); throw; }
        finally
        {
            foreach (var pending in next)
                if (!NativeDesktopIsProtectedReference(pending.Element)) NativeDesktopComOwnership.Release(pending.Element);
            NativeDesktopComOwnership.Release(walker);
        }
    }
    private static object? NativeDesktopPattern(IUIAutomationElement element, UIA_PATTERN_ID pattern)
    {
        object? owned = null;
        try
        {
            owned = NativeDesktopComOwnership.Take<object>(element.GetCurrentPattern(pattern));
            if (owned is null) return null;
            var exact = pattern switch
            {
                UIA_PATTERN_ID.UIA_InvokePatternId => owned is IUIAutomationInvokePattern,
                UIA_PATTERN_ID.UIA_SelectionItemPatternId => owned is IUIAutomationSelectionItemPattern,
                UIA_PATTERN_ID.UIA_TogglePatternId => owned is IUIAutomationTogglePattern,
                UIA_PATTERN_ID.UIA_ExpandCollapsePatternId => owned is IUIAutomationExpandCollapsePattern,
                UIA_PATTERN_ID.UIA_ScrollPatternId => owned is IUIAutomationScrollPattern,
                UIA_PATTERN_ID.UIA_ValuePatternId => owned is IUIAutomationValuePattern,
                UIA_PATTERN_ID.UIA_TextPatternId => owned is IUIAutomationTextPattern,
                _ => false
            };
            if (!exact) throw new InvalidOperationException("native_com_interface_mismatch");
            var transferred = owned; owned = null;
            return transferred;
        }
        catch (COMException error) when (error.HResult == unchecked((int)0x80040200)) { return null; }
        finally { NativeDesktopComOwnership.Release(owned); }
    }
    private static string[] NativeDesktopActions(IUIAutomationElement element, bool password, string? value, bool valueTruncated)
    {
        var actions = new List<string>(8);
        void Add(UIA_PATTERN_ID id, params string[] names)
        {
            var pattern = NativeDesktopPattern(element, id);
            try { if (pattern is not null) actions.AddRange(names); }
            finally { NativeDesktopComOwnership.Release(pattern); }
        }
        Add(UIA_PATTERN_ID.UIA_InvokePatternId, "invoke");
        Add(UIA_PATTERN_ID.UIA_SelectionItemPatternId, "select");
        Add(UIA_PATTERN_ID.UIA_TogglePatternId, "toggle");
        Add(UIA_PATTERN_ID.UIA_ExpandCollapsePatternId, "expand", "collapse");
        Add(UIA_PATTERN_ID.UIA_ScrollPatternId, "scroll");
        // Secret entry belongs to an explicit trusted human flow rather than bot context.
        if (!password) Add(UIA_PATTERN_ID.UIA_ValuePatternId, "set_value");
        // Observations reuse the already-read complete Value. Do not read document
        // contents on every walked provider. The selected action's dedicated review
        // subsequently proves TextPattern DocumentRange text equals this exact Value.
        if (!password && value is not null && !valueTruncated)
        {
            var text = NativeDesktopPattern(element, UIA_PATTERN_ID.UIA_TextPatternId);
            try
            {
                if (text is IUIAutomationTextPattern pattern &&
                    pattern.get_SupportedTextSelection() != SupportedTextSelection.SupportedTextSelection_None)
                    actions.Add("select_all_text");
            }
            finally { NativeDesktopComOwnership.Release(text); }
        }
        return actions.ToArray();
    }
    private NativeDesktopElement NativeDesktopRead(IUIAutomationElement element, string id, int depth, bool complete)
    {
        var password = (bool)element.get_CurrentIsPassword() || NativeDesktopIsProtected(element);
        if (password) NativeDesktopProtect(element, nativeDesktopHwnd, nativeDesktopPid);
        var name = NativeDesktopBstr(element.get_CurrentName, 1024, complete, out _);
        string? value = null; var valueTruncated = false;
        if (!password)
        {
            var pattern = NativeDesktopPattern(element, UIA_PATTERN_ID.UIA_ValuePatternId);
            try
            {
                if (pattern is IUIAutomationValuePattern readable)
                    value = NativeDesktopBstr(readable.get_CurrentValue, 4096, complete, out valueTruncated);
            }
            finally { NativeDesktopComOwnership.Release(pattern); }
        }
        return new(id, name, UiControlTypes.GetName((int)element.get_CurrentControlType()), value,
            password, NativeDesktopActions(element, password, value, valueTruncated), element.get_CurrentIsEnabled(),
            element.get_CurrentIsOffscreen(), depth, valueTruncated);
    }
    [DllImport("oleaut32.dll")]
    private static extern uint SysStringLen(nint text);
    private static unsafe string? NativeDesktopBstr(Func<global::Windows.Win32.Foundation.BSTR> read, int maximum, bool complete, out bool truncated)
    {
        var bstr = read();
        try
        {
            var pointer = (nint)bstr.Value;
            var length = SysStringLen(pointer);
            truncated = length > maximum;
            if (truncated && complete) throw new InvalidOperationException("element_review_too_large");
            return pointer == 0 ? null : Marshal.PtrToStringUni(pointer, checked((int)Math.Min(length, (uint)maximum)));
        }
        finally { Marshal.FreeBSTR((nint)bstr.Value); }
    }
    internal NativeDesktopElement NativeDesktopReview(string id, CancellationToken cancellation)
    {
        var element = NativeDesktopExact(id, cancellation, requireEnabled: false);
        return NativeDesktopRead(element, id, 0, complete: true);
    }
    private void NativeDesktopAssertExpected(string id, NativeDesktopExpected expected, CancellationToken cancellation)
    {
        var current = NativeDesktopReview(id, cancellation);
        var evidence = new NativeDesktopExpected(current.Name, current.ControlType, current.Value, current.Password, current.Enabled, current.Offscreen);
        if (evidence != expected) throw new InvalidOperationException("element_review_changed");
    }
    private IUIAutomationElement NativeDesktopExact(string id, CancellationToken cancellation, bool requireEnabled = true)
    {
        cancellation.ThrowIfCancellationRequested();
        if (!nativeDesktopElements.TryGetValue(id, out var element) || element.get_CurrentProcessId() != nativeDesktopPid)
            throw new InvalidOperationException("stale_element");
        if (requireEnabled && !element.get_CurrentIsEnabled()) throw new InvalidOperationException("element_disabled");
        return element;
    }
    internal NativeDesktopSecretElement NativeDesktopSecretReview(string id, CancellationToken cancellation)
    {
        var element = NativeDesktopExact(id, cancellation);
        // A formerly protected provider may now expose plaintext. Do not call the
        // generic Review/NativeDesktopRead here, including on any rejection path.
        if (!element.get_CurrentIsPassword()) throw new InvalidOperationException("password_control_changed");
        var name = NativeDesktopBstr(element.get_CurrentName, 1024, complete: true, out _);
        var controlType = UiControlTypes.GetName((int)element.get_CurrentControlType());
        var pattern = NativeDesktopPattern(element, UIA_PATTERN_ID.UIA_ValuePatternId) as IUIAutomationValuePattern
            ?? throw new InvalidOperationException("unsupported_value_pattern");
        try
        {
            if (pattern.get_CurrentIsReadOnly()) throw new InvalidOperationException("value_read_only");
            cancellation.ThrowIfCancellationRequested();
            if (!element.get_CurrentIsPassword() || !element.get_CurrentIsEnabled() || element.get_CurrentIsOffscreen())
                throw new InvalidOperationException("password_control_changed");
            return new(id, name, controlType, true, true, false);
        }
        finally { NativeDesktopComOwnership.Release(pattern); }
    }
    private void NativeDesktopAssertSecret(string id, NativeDesktopSecretElement expected, CancellationToken cancellation)
    {
        if (NativeDesktopSecretReview(id, cancellation) != expected)
            throw new InvalidOperationException("password_control_changed");
    }
    internal unsafe void NativeDesktopSetSecret(string id, string text, NativeDesktopSecretElement expected, Action beforeSubmission, CancellationToken cancellation)
    {
        NativeDesktopAssertSecret(id, expected, cancellation);
        var element = NativeDesktopExact(id, cancellation);
        var pattern = NativeDesktopPattern(element, UIA_PATTERN_ID.UIA_ValuePatternId) as IUIAutomationValuePattern
            ?? throw new InvalidOperationException("unsupported_value_pattern");
        try
        {
            if (pattern.get_CurrentIsReadOnly()) throw new InvalidOperationException("value_read_only");
            var bstr = Marshal.StringToBSTR(text);
            try
            {
                cancellation.ThrowIfCancellationRequested();
                NativeDesktopAssertSecret(id, expected, cancellation);
                beforeSubmission();
                if (!element.get_CurrentIsPassword()) throw new InvalidOperationException("password_control_changed");
                pattern.SetValue(new global::Windows.Win32.Foundation.BSTR((char*)bstr));
                // Provider/window/credential protection changes after dispatch are
                // reported unknown by the Worker and close this physical scope.
                NativeDesktopAssertSecret(id, expected, cancellation);
            }
            finally { Marshal.ZeroFreeBSTR(bstr); }
        }
        finally { NativeDesktopComOwnership.Release(pattern); }
    }
    internal unsafe void NativeDesktopSetValue(string id, string text, NativeDesktopExpected expected, Action beforeSubmission, CancellationToken cancellation)
    {
        var element = NativeDesktopExact(id, cancellation);
        if (element.get_CurrentIsPassword() || NativeDesktopIsProtected(element)) throw new InvalidOperationException("password_control_requires_human");
        var pattern = NativeDesktopPattern(element, UIA_PATTERN_ID.UIA_ValuePatternId) as IUIAutomationValuePattern
            ?? throw new InvalidOperationException("unsupported_value_pattern");
        try
        {
            if (pattern.get_CurrentIsReadOnly()) throw new InvalidOperationException("value_read_only");
            var bstr = Marshal.StringToBSTR(text);
            try
            {
                cancellation.ThrowIfCancellationRequested(); NativeDesktopAssertExpected(id, expected, cancellation); beforeSubmission();
                pattern.SetValue(new global::Windows.Win32.Foundation.BSTR((char*)bstr));
            }
            finally { Marshal.FreeBSTR(bstr); }
        }
        finally { NativeDesktopComOwnership.Release(pattern); }
    }
    private IUIAutomationTextRange NativeDesktopTextRange(string id, NativeDesktopExpected expected, CancellationToken cancellation)
    {
        var element = NativeDesktopExact(id, cancellation);
        // Check before either Value or TextPattern content is read, including retained
        // providers that no longer advertise IsPassword after a Show-password toggle.
        if (element.get_CurrentIsPassword() || NativeDesktopIsProtected(element))
            throw new InvalidOperationException("password_control_requires_human");
        if (expected.Password || expected.Value is null || expected.Value.Length > 4096)
            throw new InvalidOperationException("text_selection_evidence_unavailable");
        NativeDesktopAssertExpected(id, expected, cancellation);
        var pattern = NativeDesktopPattern(element, UIA_PATTERN_ID.UIA_TextPatternId) as IUIAutomationTextPattern
            ?? throw new InvalidOperationException("unsupported_text_selection_pattern");
        IUIAutomationTextRange? range = null;
        try
        {
            if (pattern.get_SupportedTextSelection() == SupportedTextSelection.SupportedTextSelection_None)
                throw new InvalidOperationException("unsupported_text_selection_pattern");
            range = pattern.get_DocumentRange();
            var enclosing = range.GetEnclosingElement();
            try
            {
                if (!(bool)_automation.CompareElements(element, enclosing))
                    throw new InvalidOperationException("text_selection_provider_changed");
            }
            finally
            {
                if (!nativeDesktopElements.Values.Any(item => ReferenceEquals(item, enclosing)) &&
                    !NativeDesktopIsProtectedReference(enclosing)) NativeDesktopComOwnership.Release(enclosing);
            }
            cancellation.ThrowIfCancellationRequested();
            var text = NativeDesktopBstr(() => range.GetText(4097), 4096, complete: true, out _);
            if (!string.Equals(text, expected.Value, StringComparison.Ordinal))
                throw new InvalidOperationException("text_selection_value_mismatch");
            // Content/metadata may have changed during the provider's range query.
            NativeDesktopAssertExpected(id, expected, cancellation);
            return range;
        }
        catch
        {
            if (range is not null && !textSelectionReviews.Values.Any(item => ReferenceEquals(item.Range, range)))
                NativeDesktopComOwnership.Release(range);
            throw;
        }
        finally { NativeDesktopComOwnership.Release(pattern); }
    }
    internal NativeDesktopTextSelection NativeDesktopReviewTextSelection(string id, NativeDesktopExpected expected, CancellationToken cancellation)
    {
        var range = NativeDesktopTextRange(id, expected, cancellation);
        try
        {
            var digest = Convert.ToHexStringLower(SHA256.HashData(Encoding.Unicode.GetBytes(expected.Value!)));
            if (textSelectionReviews.TryGetValue(id, out var retained))
            {
                if (retained.Evidence.TextSha256 != digest || retained.Evidence.Utf16Length != expected.Value!.Length ||
                    !(bool)range.Compare(retained.Range)) throw new InvalidOperationException("text_selection_review_changed");
                return retained.Evidence;
            }
            if (textSelectionReviews.Count >= TextSelectionReviewLimit)
                throw new InvalidOperationException("text_selection_review_limit");
            var evidence = new NativeDesktopTextSelection(Guid.NewGuid().ToString("D"), digest, expected.Value!.Length);
            textSelectionReviews.Add(id, new(evidence, range));
            return evidence;
        }
        finally
        {
            if (!textSelectionReviews.Values.Any(item => ReferenceEquals(item.Range, range))) NativeDesktopComOwnership.Release(range);
        }
    }
    private void NativeDesktopSelectAllText(string id, NativeDesktopExpected expected, NativeDesktopTextSelection? evidence,
        Action beforeSubmission, CancellationToken cancellation)
    {
        if (evidence is null || !textSelectionReviews.TryGetValue(id, out var retained) || retained.Evidence != evidence)
            throw new InvalidOperationException("text_selection_review_required");
        try
        {
            var current = NativeDesktopReviewTextSelection(id, expected, cancellation);
            if (current != evidence) throw new InvalidOperationException("text_selection_review_changed");
            cancellation.ThrowIfCancellationRequested();
            NativeDesktopAssertExpected(id, expected, cancellation);
            beforeSubmission();
            retained.Range.Select();
        }
        finally
        {
            textSelectionReviews.Remove(id);
            NativeDesktopComOwnership.Release(retained.Range);
        }
    }
    internal void NativeDesktopInvoke(string id, UiInvokeAction action, NativeDesktopExpected expected,
        NativeDesktopTextSelection? textSelection, Action beforeSubmission, CancellationToken cancellation)
    {
        if (action == UiInvokeAction.SelectAllText)
        {
            NativeDesktopSelectAllText(id, expected, textSelection, beforeSubmission, cancellation);
            return;
        }
        if (textSelection is not null) throw new InvalidOperationException("unsupported_invoke_action");
        if (action is not (UiInvokeAction.Invoke or UiInvokeAction.Select or UiInvokeAction.Toggle or UiInvokeAction.Expand or UiInvokeAction.Collapse))
            throw new InvalidOperationException("unsupported_invoke_action");
        var element = NativeDesktopExact(id, cancellation);
        var patternId = action switch
        {
            UiInvokeAction.Invoke => UIA_PATTERN_ID.UIA_InvokePatternId,
            UiInvokeAction.Select => UIA_PATTERN_ID.UIA_SelectionItemPatternId,
            UiInvokeAction.Toggle => UIA_PATTERN_ID.UIA_TogglePatternId,
            _ => UIA_PATTERN_ID.UIA_ExpandCollapsePatternId
        };
        var pattern = NativeDesktopPattern(element, patternId) ?? throw new InvalidOperationException("unsupported_invoke_pattern");
        try
        {
            cancellation.ThrowIfCancellationRequested(); NativeDesktopAssertExpected(id, expected, cancellation); beforeSubmission();
            switch (action)
            {
                case UiInvokeAction.Invoke: ((IUIAutomationInvokePattern)pattern).Invoke(); break;
                case UiInvokeAction.Select: ((IUIAutomationSelectionItemPattern)pattern).Select(); break;
                case UiInvokeAction.Toggle: ((IUIAutomationTogglePattern)pattern).Toggle(); break;
                case UiInvokeAction.Expand: ((IUIAutomationExpandCollapsePattern)pattern).Expand(); break;
                case UiInvokeAction.Collapse: ((IUIAutomationExpandCollapsePattern)pattern).Collapse(); break;
            }
        }
        finally { NativeDesktopComOwnership.Release(pattern); }
    }
    internal void NativeDesktopScroll(string id, string direction, bool large, NativeDesktopExpected expected, Action beforeSubmission, CancellationToken cancellation)
    {
        if (direction is not ("up" or "down" or "left" or "right")) throw new InvalidOperationException("invalid_scroll_direction");
        var element = NativeDesktopExact(id, cancellation);
        var pattern = NativeDesktopPattern(element, UIA_PATTERN_ID.UIA_ScrollPatternId) as IUIAutomationScrollPattern
            ?? throw new InvalidOperationException("unsupported_scroll_pattern");
        try
        {
            var increase = direction is "down" or "right";
            var amount = (large, increase) switch
            {
                (true, true) => ScrollAmount.ScrollAmount_LargeIncrement,
                (true, false) => ScrollAmount.ScrollAmount_LargeDecrement,
                (false, true) => ScrollAmount.ScrollAmount_SmallIncrement,
                _ => ScrollAmount.ScrollAmount_SmallDecrement
            };
            var vertical = direction is "up" or "down";
            if (vertical ? !pattern.get_CurrentVerticallyScrollable() : !pattern.get_CurrentHorizontallyScrollable())
                throw new InvalidOperationException("unsupported_scroll_direction");
            cancellation.ThrowIfCancellationRequested(); NativeDesktopAssertExpected(id, expected, cancellation); beforeSubmission();
            pattern.Scroll(vertical ? ScrollAmount.ScrollAmount_NoAmount : amount,
                vertical ? amount : ScrollAmount.ScrollAmount_NoAmount);
        }
        finally { NativeDesktopComOwnership.Release(pattern); }
    }
    internal void NativeDesktopClear()
    {
        foreach (var selection in textSelectionReviews.Values) NativeDesktopComOwnership.Release(selection.Range);
        textSelectionReviews.Clear();
        foreach (var element in nativeDesktopElements.Values)
            if (!NativeDesktopIsProtectedReference(element)) NativeDesktopComOwnership.Release(element);
        nativeDesktopElements.Clear();
        nativeDesktopPid = 0;
        nativeDesktopHwnd = 0;
    }
    internal void NativeDesktopDispose()
    {
        foreach (var item in protectedProviders) NativeDesktopComOwnership.Release(item.Element);
        protectedProviders.Clear();
        NativeDesktopComOwnership.Release(_automation);
    }
}
