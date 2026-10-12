using System.Diagnostics;
using System.Globalization;
using System.Text.Json;

namespace CMBDevClaw.NativeSelectionFixture;

// Extends the existing G2B WinForms experiment shape, without foreground input,
// hooks, raw UIA calls, worker test opcodes, privileges or a second native owner.
internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (!OperatingSystem.IsWindows() || args.Length != 2 || args[0] != "--proof-root" ||
            !Path.IsPathFullyQualified(args[1]) || !Directory.Exists(args[1]))
            throw new ArgumentException("Explicit Windows fixture proof root required");
        ApplicationConfiguration.Initialize();
        Application.Run(new SelectionFixture(Path.GetFullPath(args[1])));
    }
}

internal sealed class SelectionFixture : Form
{
    private const string InitialText = "CMB native selection: hello 中文 42";
    private readonly RichTextBox editor = new()
    {
        Name = "cmb-selection-text", AccessibleName = "cmb-selection-text",
        Multiline = false, Text = InitialText, Dock = DockStyle.Top, Height = 72,
        HideSelection = false, DetectUrls = false
    };
    private readonly System.Windows.Forms.Timer timer = new() { Interval = 100 };
    private readonly string proofRoot;
    private readonly Stopwatch lifetime = Stopwatch.StartNew();
    private string? lastProof;
    private long revision;
    public SelectionFixture(string root)
    {
        proofRoot = root;
        Text = "CMBDevClaw Native Selection Acceptance";
        ClientSize = new Size(640, 420);
        StartPosition = FormStartPosition.Manual;
        Location = new Point(64, 64);
        BackColor = Color.FromArgb(220, 32, 48);
        Controls.Add(editor);
        timer.Tick += Tick;
        Shown += (_, _) =>
        {
            // Deliberately not SelectAll; selection evidence must originate from
            // the production worker's approved TextPattern range action.
            editor.Select(0, 0);
            Publish();
            timer.Start();
        };
    }
    protected override bool ShowWithoutActivation => true;
    private void Tick(object? sender, EventArgs args)
    {
        if (lifetime.ElapsedMilliseconds >= 55_000) { Close(); return; }
        Publish();
    }
    private void Publish()
    {
        // Read real GUI-thread control state. No JSON value is accepted as a
        // capability or as evidence that the worker belongs to an owned Job.
        var identity = new
        {
            pid = Environment.ProcessId,
            hwnd = Handle.ToInt64().ToString(CultureInfo.InvariantCulture),
            text = editor.Text,
            selectionStart = editor.SelectionStart,
            selectionLength = editor.SelectionLength
        };
        var content = JsonSerializer.Serialize(identity);
        if (content == lastProof) return;
        var proof = JsonSerializer.Serialize(new { version = 1, revision = ++revision, state = identity });
        var temporary = Path.Combine(proofRoot, "selection-proof.tmp");
        File.WriteAllText(temporary, proof);
        File.Move(temporary, Path.Combine(proofRoot, "selection-proof.json"), true);
        lastProof = content;
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing) { timer.Stop(); timer.Tick -= Tick; timer.Dispose(); }
        base.Dispose(disposing);
    }
}
