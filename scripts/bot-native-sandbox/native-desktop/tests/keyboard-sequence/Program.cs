using CmbNativeDesktop;

// Tests link the actual production helper; no copied implementation, kernel or physical-input claim.
static void Require(bool value, string name) { if (!value) throw new InvalidOperationException(name); }
WindowKeyboardStroke[] strokes = [new(0x11, false, 0x1d, false), new(0x10, false, 0x2a, false), new(0x12, false, 0x38, false), new(0x73, false, 0x3e, true)];
var released = new List<WindowKeyboardStroke>();
WindowKeyboardSequence.Deliver(strokes, _ => {}, released.Add);
Require(released.SequenceEqual(strokes.Reverse()), "successful chord reverse releases");
for (var cut = 0; cut < strokes.Length; cut++)
{
    var accepted = new List<WindowKeyboardStroke>(); released.Clear();
    var cancellation = new OperationCanceledException("original cancellation");
    Exception? actual = null;
    try
    {
        WindowKeyboardSequence.Deliver(strokes, item => {
            if (accepted.Count == cut) throw cancellation;
            accepted.Add(item);
        }, released.Add);
    }
    catch (Exception error) { actual = error; }
    Require(ReferenceEquals(actual,cancellation), "original cancellation preserved");
    Require(released.SequenceEqual(accepted.AsEnumerable().Reverse()), "only accepted downs released after cancellation");
}
{
    var primary = new InvalidOperationException("original identity/focus changed");
    var cleanup = new InvalidOperationException("original release unavailable");
    var accepted = new List<WindowKeyboardStroke>(); released.Clear(); Exception? actual = null;
    try
    {
        WindowKeyboardSequence.Deliver(strokes, item => {
            if (accepted.Count == 3) throw primary;
            accepted.Add(item);
        }, item => { released.Add(item); throw cleanup; });
    }
    catch (Exception error) { actual = error; }
    Require(ReferenceEquals(actual,primary), "cleanup must not overwrite primary");
    Require(released.SequenceEqual(accepted.AsEnumerable().Reverse()), "one failed release does not strand the remaining modifiers");
    Require(primary.Data.Contains("native_keyboard_release_failure"), "cleanup failure retained as secondary");
}
{
    var cleanup = new InvalidOperationException("release failed");
    var attempted = 0; Exception? actual = null;
    try { WindowKeyboardSequence.Deliver(strokes,_=>{},_=>{attempted++;throw cleanup;}); }
    catch (Exception error) { actual=error; }
    Require(ReferenceEquals(actual,cleanup) && attempted==4,"all original releases attempted on ordinary cleanup failure");
}
Require(WindowKeyboardSequence.BuildKeyLParam(false,false,0x3e,true)==0x203e0001U,"ALT context key down");
Require(WindowKeyboardSequence.BuildKeyLParam(true,false,0x3e,true)==0xe03e0001U,"ALT context + previous/transition key up");
Require(WindowKeyboardSequence.BuildKeyLParam(true,true,0x4b)==0xc14b0001U,"extended key up");
Require(WindowKeyboardSequence.ValidText("中文🙂") && WindowKeyboardSequence.ValidText(new string('x',4096)),"complete bounded Unicode");
foreach(var invalid in new[]{"", "a\0b", "\ud800", "\udc00", new string('x',4097)})
    Require(!WindowKeyboardSequence.ValidText(invalid),"malformed or oversized Unicode rejected before any down");
Console.WriteLine("Production sequence cancellation/cleanup/encoding and Unicode regressions passed; no Windows acceptance claimed.");
