using System.Buffers.Binary;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CmbNativeDesktop;

internal static class Wire
{
    internal const string Protocol = "cmb-native-desktop-v1";
    internal const int Version = 1;
    internal const int MaximumInput = 64 * 1024;
    internal const int MaximumOutput = 8 * 1024 * 1024;
    internal const long MaximumSafeInteger = 9007199254740991;
    private static readonly object Gate = new();
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        MaxDepth = 16
    };
    internal static Incoming? Read(Stream source)
    {
        Span<byte> header = stackalloc byte[4];
        var first = source.ReadByte();
        if (first < 0) return null;
        header[0] = (byte)first;
        source.ReadExactly(header[1..]);
        var length = BinaryPrimitives.ReadUInt32BigEndian(header);
        if (length is 0 or > MaximumInput) throw new InvalidDataException("invalid_frame_size");
        var bytes = new byte[(int)length];
        source.ReadExactly(bytes);
        using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 16 });
        RejectDuplicates(document.RootElement);
        return document.RootElement.Deserialize<Incoming>(Json) ?? throw new InvalidDataException("empty_frame");
    }
    private static void RejectDuplicates(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in element.EnumerateObject())
            {
                if (!names.Add(property.Name) || names.Count > 64) throw new InvalidDataException("invalid_object_members");
                RejectDuplicates(property.Value);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            if (element.GetArrayLength() > 512) throw new InvalidDataException("invalid_array_size");
            foreach (var child in element.EnumerateArray()) RejectDuplicates(child);
        }
    }
    internal static void Emit(object value)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(value, Json);
        if (bytes.Length > MaximumOutput) throw new InvalidDataException("response_too_large");
        Span<byte> header = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(header, (uint)bytes.Length);
        lock (Gate)
        {
            var stdout = Console.OpenStandardOutput();
            stdout.Write(header);
            stdout.Write(bytes);
            stdout.Flush();
        }
    }
    internal static string CanonicalLong(long value) => value.ToString(CultureInfo.InvariantCulture);
    internal static long PositiveDecimal(string text)
    {
        if (text.Length is < 1 or > 19 || text[0] == '0' || text.Any(c => c is < '0' or > '9') ||
            !long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var value) || value <= 0)
            throw new InvalidDataException("invalid_decimal_identity");
        return value;
    }
    internal static long Hwnd(string text)
    {
        if (!long.TryParse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var value) ||
            value == 0 || CanonicalLong(value) != text) throw new InvalidDataException("invalid_hwnd");
        return value;
    }
    internal static void Identifier(string value, bool uuid = false)
    {
        if (value.Length is < 1 or > 256 || value.Any(char.IsControl) ||
            uuid && !Guid.TryParseExact(value, "D", out _)) throw new InvalidDataException("invalid_identity");
    }
}

internal sealed record Scope(string HostId, string DataEpoch, string BotId, string? TaskRunId,
    string Generation, long ControlEpoch, string Control)
{
    internal void Validate()
    {
        Wire.Identifier(HostId); Wire.Identifier(DataEpoch); Wire.Identifier(BotId, true);
        if (TaskRunId is not null) Wire.Identifier(TaskRunId, true);
        Wire.Identifier(Generation, true);
        if (ControlEpoch < 0 || ControlEpoch > Wire.MaximumSafeInteger || Control is not ("bot" or "human" or "handoff"))
            throw new InvalidDataException("invalid_control_scope");
    }
}
internal sealed record WindowIdentity(string Hwnd, int Pid, string StartTicks, int SessionId, string Desktop);
internal sealed record WorkerIdentity(int Pid, string StartTicks, int SessionId, string Desktop);
internal sealed record Incoming(string Type, string Protocol, int Version, string Id, long Sequence,
    string Nonce, Scope Scope, string? Operation, WindowIdentity? Window, JsonElement Params);
internal sealed class DesktopException(string code) : Exception(code);
