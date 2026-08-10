#pragma once
#include <JuceHeader.h>
#include <vector>

/**
    Reading notes back out of a Standard MIDI File.

    WHY THIS EXISTS. Both one-click engines are MIDI writers, not JSON writers.
    The AMT engine gets a Riffsheet sidecar script in front of it that can print
    notes directly, but Transkun is a pip console script with a fixed command
    line - `transkun in.wav out.mid` - and putting a Python wrapper in front of a
    console script only to translate its own output would be a second thing to
    install and a second thing to break.

    WHY IT IS FIFTY LINES AND NOT A PARSER. juce::MidiFile already reads SMF,
    already knows the tempo map, and already pairs note-ons with note-offs
    (updateMatchedPairs / getTimeOfMatchingKeyUp). Writing another parser next to
    it would be new code whose only distinguishing feature is being younger. What
    is here is the part JUCE does not decide: which events count as notes, what
    to do with one that never ends, and what to call the instrument.

    A note whose key-up never arrives is DROPPED rather than given an invented
    length. These files come out of a model, an unterminated note means the
    engine did not decide where it ended, and this codebase does not fill a
    missing number in with a default.
*/
namespace SidecarMidi
{
    struct Note
    {
        double start = 0.0;     // seconds
        double end = 0.0;       // seconds, always > start
        int pitch = 0;          // MIDI note number
        int velocity = 0;       // 1..127
        juce::String instrument;// the track name when the file carries one, else ""
    };

    struct Result
    {
        std::vector<Note> notes;    // sorted by start, then pitch
        int droppedUnterminated = 0;
        juce::String error;         // "" when the file was read
    };

    /** Reads every note in every track, in seconds on the file's own tempo map. */
    Result read (const juce::File& midiFile);

    /** The same, over bytes already in memory - which is what the unit test uses
        so it can build a file with juce::MidiFile and read it straight back. */
    Result read (juce::InputStream& stream);
}
