// Copyright (c) Microsoft Corporation and Contributors. All rights reserved.
// Licensed under the MIT License.

using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.Marshalling;
using Microsoft.Extensions.Logging;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Win32;
using Windows.Win32.Foundation;
using D3D = Windows.Win32.Graphics.Direct3D11;
using D3DCommon = Windows.Win32.Graphics.Direct3D;
using DxgiCommon = Windows.Win32.Graphics.Dxgi.Common;
using WinRT;

namespace Microsoft.Windows.SDK.BuildTools.WinApp.UIAutomation;

internal static partial class WgcCapture
{
    private static readonly Guid GraphicsCaptureItemGuid = new("79C3F95B-31F7-4EC2-A464-632EF5D30760");
    private static readonly Guid GraphicsCaptureItemInteropGuid = new("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356");
    private static readonly Guid Direct3DDxgiInterfaceAccessGuid = new("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1");
    private static readonly Guid DxgiDeviceGuid = new("54EC77FA-1377-44E6-8C32-88FD5F44C84C");
    private static readonly Guid D3D11Texture2DGuid = new("6F15AAF2-D208-4E89-9AB4-489535D34F9C");

    // D3D11_SDK_VERSION — must be 7 per d3d11.h. CsWin32 doesn't project the
    // numeric constant for this header, so it's defined here.
    private const uint D3D11_SDK_VERSION = 7;
    internal static Func<bool> s_isSupported = GraphicsCaptureSession.IsSupported;

    public static bool IsSupported()
    {
        try
        {
            return s_isSupported();
        }
        catch
        {
            return false;
        }
    }

    /// <remarks>
    /// Coverage ceiling (issue #630): this is the innermost WinRT/DXGI projection boundary for
    /// global::Windows.Graphics.Capture. It requires a real D3D device and COM ABI ownership transfer; tests
    /// cover callers and cleanup seams, while this native interop call remains environment-bound.
    /// </remarks>
    private static unsafe IDirect3DDevice CreateDirect3DDevice(D3D.ID3D11Device device)
    {
        var d3dDevicePtr = ComInterfaceMarshaller<D3D.ID3D11Device>.ConvertToUnmanaged(device);
        IntPtr dxgiDevicePtr = IntPtr.Zero;
        IntPtr graphicsDevicePtr = IntPtr.Zero;
        try
        {
            Marshal.QueryInterface((IntPtr)d3dDevicePtr, in DxgiDeviceGuid, out dxgiDevicePtr).ThrowIfFailed("ID3D11Device.QueryInterface(IDXGIDevice)");
            CreateDirect3D11DeviceFromDXGIDevice(dxgiDevicePtr, out graphicsDevicePtr).ThrowIfFailed("CreateDirect3D11DeviceFromDXGIDevice");

            // C#/WinRT FromAbi creates/caches its own projection reference. The ABI
            // output remains ours and is released independently in finally.
            return MarshalInspectable<IDirect3DDevice>.FromAbi(graphicsDevicePtr);
        }
        finally
        {
            if (graphicsDevicePtr != IntPtr.Zero)
            {
                Marshal.Release(graphicsDevicePtr);
            }

            if (dxgiDevicePtr != IntPtr.Zero)
            {
                Marshal.Release(dxgiDevicePtr);
            }

            if (d3dDevicePtr is not null)
            {
                ComInterfaceMarshaller<D3D.ID3D11Device>.Free(d3dDevicePtr);
            }
        }
    }

    /// <remarks>
    /// Coverage ceiling (issue #630): this is the innermost IGraphicsCaptureItemInterop native call.
    /// It can only succeed for a real HWND on an interactive desktop and cannot be faked without
    /// replacing the WinRT activation factory itself.
    /// </remarks>
    private static unsafe GraphicsCaptureItem CreateItemForWindow(HWND hwnd)
    {
        using var factory = ActivationFactory.Get("Windows.Graphics.Capture.GraphicsCaptureItem");
        IntPtr interopPtr = IntPtr.Zero;
        IntPtr itemPtr = IntPtr.Zero;
        IGraphicsCaptureItemInterop? interop = null;
        try
        {
            Marshal.QueryInterface(factory.ThisPtr, in GraphicsCaptureItemInteropGuid, out interopPtr).ThrowIfFailed("GraphicsCaptureItem.QueryInterface(IGraphicsCaptureItemInterop)");

            var ownedInterop = interopPtr; interopPtr = IntPtr.Zero;
            interop = NativeDesktopComOwnership.Take<IGraphicsCaptureItemInterop>(ownedInterop)
                ?? throw new InvalidOperationException("capture_interop_unavailable");

            interop.CreateForWindow(hwnd, in GraphicsCaptureItemGuid, out itemPtr).ThrowIfFailed("GraphicsCaptureItem.CreateForWindow");

            // Keep the projection in its WinRT ownership domain; release our raw ABI
            // output below rather than closing or FinalRelease-ing its shared wrapper.
            return MarshalInspectable<GraphicsCaptureItem>.FromAbi(itemPtr);
        }
        finally
        {
            if (itemPtr != IntPtr.Zero)
            {
                Marshal.Release(itemPtr);
            }

            if (interopPtr != IntPtr.Zero)
            {
                NativeDesktopComOwnership.Free(interopPtr);
            }
            NativeDesktopComOwnership.Release(interop);
        }
    }

    /// <remarks>
    /// Coverage ceiling (issue #630): GPU-to-CPU readback depends on live WGC/D3D frame resources.
    /// Deterministic tests cover blank-frame detection and record orchestration; this native copy loop
    /// is exercised only on hosts where global::Windows.Graphics.Capture produces non-blank frames.
    /// </remarks>
    private static unsafe (byte[] Pixels, int Width, int Height) CopyFrame(
        D3D.ID3D11Device device,
        D3D.ID3D11DeviceContext context,
        Direct3D11CaptureFrame frame)
    {
        var capturedTexture = GetTexture(frame.Surface);
        try
        {
            var size = frame.ContentSize;
            var width = size.Width;
            var height = size.Height;
            if (width <= 0 || height <= 0)
            {
                throw new InvalidOperationException("WGC returned an empty frame.");
            }

            var desc = new D3D.D3D11_TEXTURE2D_DESC
            {
                Width = (uint)width,
                Height = (uint)height,
                MipLevels = 1,
                ArraySize = 1,
                Format = DxgiCommon.DXGI_FORMAT.DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc = new DxgiCommon.DXGI_SAMPLE_DESC { Count = 1, Quality = 0 },
                Usage = D3D.D3D11_USAGE.D3D11_USAGE_STAGING,
                BindFlags = 0,
                CPUAccessFlags = D3D.D3D11_CPU_ACCESS_FLAG.D3D11_CPU_ACCESS_READ,
                MiscFlags = 0,
            };

            var stagingTexture = CreateStagingTexture(device, in desc);
            try
            {
                context.CopyResource(stagingTexture, capturedTexture);
                context.Map(stagingTexture, 0, D3D.D3D11_MAP.D3D11_MAP_READ, 0, out var mapped);
                try
                {
                    var pixels = new byte[checked(width * height * 4)];
                    fixed (byte* destination = pixels)
                    {
                        var rowBytes = width * 4;
                        for (var row = 0; row < height; row++)
                        {
                            Buffer.MemoryCopy(
                                (byte*)mapped.pData + (row * mapped.RowPitch),
                                destination + (row * rowBytes),
                                rowBytes,
                                rowBytes);
                        }
                    }

                    return (pixels, width, height);
                }
                finally
                {
                    context.Unmap(stagingTexture, 0);
                }
            }
            finally
            {
                NativeDesktopComOwnership.Release(stagingTexture);
            }
        }
        finally
        {
            NativeDesktopComOwnership.Release(capturedTexture);
        }
    }

    /// <remarks>
    /// Coverage ceiling (issue #630): this is the innermost IDirect3DDxgiInterfaceAccess COM
    /// extraction for a WinRT surface. It requires a real Direct3D surface and covers only native ABI
    /// ownership/error cleanup that cannot be triggered safely with managed fakes.
    /// </remarks>
    private static unsafe D3D.ID3D11Texture2D GetTexture(IDirect3DSurface surface)
    {
        var surfacePtr = ((IWinRTObject)surface).NativeObject.ThisPtr;
        IntPtr accessPtr = IntPtr.Zero;
        IntPtr texturePtr = IntPtr.Zero;
        IDirect3DDxgiInterfaceAccess? access = null;
        try
        {
            Marshal.QueryInterface(surfacePtr, in Direct3DDxgiInterfaceAccessGuid, out accessPtr).ThrowIfFailed("IDirect3DSurface.QueryInterface(IDirect3DDxgiInterfaceAccess)");
            var ownedAccess = accessPtr; accessPtr = IntPtr.Zero;
            access = NativeDesktopComOwnership.Take<IDirect3DDxgiInterfaceAccess>(ownedAccess)
                ?? throw new InvalidOperationException("capture_surface_unavailable");
            access.GetInterface(in D3D11Texture2DGuid, out texturePtr).ThrowIfFailed("IDirect3DDxgiInterfaceAccess.GetInterface");
            var ownedTexture = texturePtr; texturePtr = IntPtr.Zero;
            return NativeDesktopComOwnership.Take<D3D.ID3D11Texture2D>(ownedTexture)
                ?? throw new InvalidOperationException("capture_texture_unavailable");
        }
        finally
        {
            NativeDesktopComOwnership.Free(texturePtr);
            NativeDesktopComOwnership.Free(accessPtr);
            NativeDesktopComOwnership.Release(access);
            // surfacePtr is borrowed from this projection; it was never AddRef'd here.
            GC.KeepAlive(surface);
        }
    }

    private static unsafe D3D.ID3D11Texture2D CreateStagingTexture(D3D.ID3D11Device device, in D3D.D3D11_TEXTURE2D_DESC desc)
    {
        // The pinned CsWin32 friendly overload explicitly uses the shared converter.
        // Use its exact generated raw method instead, then consume the returned ref.
        D3D.ID3D11Texture2D_unmanaged* raw = null;
        try
        {
            var nativeDesc = desc;
            device.CreateTexture2D(&nativeDesc, null, &raw);
            var owned = raw; raw = null;
            return NativeDesktopComOwnership.Take<D3D.ID3D11Texture2D>((nint)owned)
                ?? throw new InvalidOperationException("capture_staging_unavailable");
        }
        finally { NativeDesktopComOwnership.Free((nint)raw); }
    }

    private static void Cleanup(params Action[] actions)
    {
        List<Exception>? failures = null;
        foreach (var action in actions)
        {
            try { action(); }
            catch (Exception error) { (failures ??= []).Add(error); }
        }
        if (failures is { Count: 1 }) ExceptionDispatchInfo.Capture(failures[0]).Throw();
        if (failures is { Count: > 1 }) throw new AggregateException(failures);
    }

    internal static bool IsBlankCapture(byte[] pixels) => CapturedFrame.IsBlank(pixels);

    [LibraryImport("d3d11.dll")]
    private static partial int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);

    [GeneratedComInterface]
    [Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356")]
    internal partial interface IGraphicsCaptureItemInterop
    {
        [PreserveSig]
        int CreateForWindow(HWND window, in Guid iid, out IntPtr result);

        [PreserveSig]
        int CreateForMonitor(IntPtr monitor, in Guid iid, out IntPtr result);
    }

    [GeneratedComInterface]
    [Guid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1")]
    internal partial interface IDirect3DDxgiInterfaceAccess
    {
        [PreserveSig]
        int GetInterface(in Guid iid, out IntPtr ppvObject);
    }

    internal static void ThrowIfFailed(this int hr, string operation)
    {
        if (hr < 0)
        {
            throw new InvalidOperationException(FormattableString.Invariant($"{operation} failed with HRESULT 0x{hr:X8}."), Marshal.GetExceptionForHR(hr));
        }
    }
}
