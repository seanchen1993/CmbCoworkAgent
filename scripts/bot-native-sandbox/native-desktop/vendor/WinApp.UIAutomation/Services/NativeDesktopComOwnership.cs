// Owned unique COM wrappers only. This helper never handles C#/WinRT projected objects.
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.Marshalling;
using Windows.Win32.UI.Accessibility;

namespace Microsoft.Windows.SDK.BuildTools.WinApp.UIAutomation;

internal static partial class NativeDesktopComOwnership
{
    private static readonly Guid AutomationClass = new("E22AD333-B25F-460C-83D0-0581107395C9");
    private static readonly Guid AutomationInterface = new("30CBE57D-D9D0-452A-AB13-7AC5AC4825EE");

    [LibraryImport("ole32.dll")]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static partial int CoCreateInstance(in Guid clsid, nint outer, uint context, in Guid iid, out nint result);

    internal static IUIAutomation CreateAutomation()
    {
        nint raw = 0;
        try
        {
            // CLSCTX_SERVER: same inproc/local-server scope as pinned CUIAutomation8.CreateInstance.
            Marshal.ThrowExceptionForHR(CoCreateInstance(in AutomationClass, 0, 0x15, in AutomationInterface, out raw));
            var transferred = raw; raw = 0;
            return Take<IUIAutomation>(transferred) ?? throw new InvalidOperationException("uia_automation_unavailable");
        }
        finally { Free(raw); }
    }

    // Take consumes the caller's native reference even when conversion/type checking fails.
    // Convert as object first, so a failed typed cast does not abandon the created unique wrapper.
    internal static unsafe T? Take<T>(nint raw) where T : class
    {
        object? owned = null;
        try
        {
            if (raw == 0) return null;
            owned = UniqueComInterfaceMarshaller<object>.ConvertToManaged((void*)raw);
            if (owned is not ComObject || owned is not T typed)
                throw new InvalidOperationException("native_com_interface_mismatch");
            owned = null;
            return typed;
        }
        finally
        {
            try { Release(owned); }
            finally { Free(raw); }
        }
    }

    internal static unsafe void Free(nint raw) => UniqueComInterfaceMarshaller<object>.Free((void*)raw);

    // Acquisitions below are unique by construction and checked generated signatures.
    // FinalRelease is idempotent for this one owner; shared wrappers are never admitted here.
    internal static void Release(object? owned)
    {
        if (owned is null) return;
        if (owned is not ComObject com) throw new InvalidOperationException("native_com_owner_mismatch");
        com.FinalRelease();
    }
}
