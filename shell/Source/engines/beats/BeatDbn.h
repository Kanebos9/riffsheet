#pragma once
#include <JuceHeader.h>
#include <vector>

/**
    The bar-pointer dynamic Bayesian network that turns framewise beat and
    downbeat logits into beat times and bar positions.

    WHAT THIS IS, AND WHOSE IT IS. The model is Krebs, Bock and Widmer's
    "An Efficient State Space Model for Joint Tempo and Meter Tracking"
    (ISMIR 2015), applied to neural activations as in Bock, Krebs and Widmer,
    "Joint Beat and Downbeat Tracking with Recurrent Neural Networks"
    (ISMIR 2016). A bar of N beats is a chain of states; each state carries a
    position within the bar and a tempo (an inter-beat interval in frames);
    within a beat the pointer advances deterministically and only at a beat
    boundary may the tempo change, with an exponentially decaying penalty on the
    ratio. Viterbi finds the single most probable path and the beats are the
    frames where the path is inside a beat.

    THE CODE IS RIFFSHEET'S OWN. It was written from the papers and the parameter
    values, first in Python (scratchpad/dbn_ref.py) so it could be checked frame
    for frame against madmom's DBNDownBeatTrackingProcessor, and only then
    transliterated here. That check is what shell/test/golden/beats-*.json is:
    those files were produced by madmom, before this file existed.

    ON LICENCES, because engine-architecture.md 6.4 states this incorrectly and
    the correction matters. It says madmom "is not licensed compatibly for this".
    madmom's LICENSE is in fact a split: its .npy/.npz/.h5/.hdf5/.pkl/.mat MODEL
    and DATA files are CC BY-NC-SA 4.0 - "You must not use the material for
    commercial purposes" - while its SOURCE files are BSD 2-Clause, which is
    perfectly redistributable. The DBN is pure source and needs no model file at
    all, so vendoring it would have been legal. Riffsheet does not ship it anyway:
    a pip dependency was the thing wave 4 exists to delete, madmom's models
    directory would have come along with the package, and a self-contained
    implementation is 400 lines. Nothing here is copied from madmom or from
    mosynthkey/beat_this_cpp (MIT), which is the other C++ port of the same model.

    The DEFAULTS are madmom's, because the golden was captured with them and
    because beat_this's own dbn=True path constructs the processor with them -
    except min_bpm, which is Riffsheet's product decision (see kMinBpm).
*/
namespace BeatDbn
{
    //== parameters ===========================================================

    constexpr double kFps = 50.0;              // the model's frame rate, 22050/441

    /** THE ONE PARAMETER THAT IS NOT UPSTREAM'S. beat_this's dbn=True path uses
        min_bpm = 55, which cannot represent a slow ballad at all: the state space
        simply has no interval long enough, so the tracker locks onto every second
        beat and reports a plausible, wrong, doubled tempo. 30 BPM is the value
        the product decision names (engine-architecture.md 6.4). The cost is a
        larger state space - 60 intervals spanning 14..100 frames instead of
        14..55 - which is paid once per analysis. */
    constexpr double kMinBpm = 30.0;
    constexpr double kMaxBpm = 215.0;          // upstream's default

    /** Tempi are LOG-spaced when there are more integer intervals available than
        this, which at min_bpm=30 there are (87 of them). Dropping this would
        change the state space and therefore the answer. */
    constexpr int kNumTempi = 60;

    constexpr double kTransitionLambda = 100.0;   // higher = stronger preference for a steady tempo
    constexpr int    kObservationLambda = 16;     // 1/16 of a beat period counts as "on the beat"
    constexpr double kThreshold = 0.05;           // trim leading/trailing frames below this
    /** Candidate bar lengths, one HMM each, highest path probability wins.

        {3, 4} is madmom's and beat_this's default pair, and it is the set the
        parity goldens in test/golden were captured with - they record it under
        `dbn.beatsPerBar`, and the whole worth of those files is that they came
        out of the Python reference before any of this C++ existed.

        WIDENING THIS WAS TRIED AND REVERTED. {2,3,4,5,6,7} was measured here so
        that 6/8, 5/4 and 7/8 could be represented at all, which is a real gap for
        a riff tool. The 120 BPM click track was unaffected (71 beats, 100% within
        10 ms, still 4/4), but the held-note fixture went from 5 beats to 3: on
        sparse evidence the extra candidates let the decoder buy a lower beat
        count with a longer bar, so the change does not merely allow odd metres,
        it loses beats on weak material. Fixing that needs the observation model
        looked at, not another entry in this list.

        Do not "update the goldens" to make a widened set pass. They cannot be
        regenerated from this repository - they need beat_this 1.1.0, madmom
        0.17.dev0 and torch under Python 3.10 - and rewriting them from our own
        output would turn a parity test into a recording of whatever we last did. */
    constexpr int    kBeatsPerBarOptions[] = { 3, 4 };

    //== input ================================================================

    /** Turns the model's two logit streams into the DBN's two-column activation.

        This mapping is beat_this's, not madmom's (Postprocessor.postp_dbn):
        column 0 is sigmoid(beat) MINUS sigmoid(downbeat), so a frame the network
        calls a downbeat does not also compete as a plain beat, and both columns
        are pulled off 0 and 1 by epsilon because the DBN takes their logarithm. */
    void activationsFromLogits (const std::vector<float>& beatLogits,
                                const std::vector<float>& downbeatLogits,
                                std::vector<float>& out);   // frames * 2, interleaved

    //== output ===============================================================

    struct Result
    {
        std::vector<double> beats;      // seconds
        std::vector<int> beatNumbers;   // 1-based position in the bar, same length
        std::vector<double> downbeats;  // the subset of `beats` whose number is 1
        int beatsPerBar = 0;            // the bar length the winning HMM modelled
    };

    /** Decodes `activations` (frames x 2, interleaved, from the function above).

        Never fails and never throws: an input with nothing above kThreshold
        simply comes back empty, which is the honest answer for four seconds of a
        held bass note. `shouldCancel` is polled per frame, so a cancel lands
        within a millisecond rather than at the end of a five-minute take. */
    Result track (const std::vector<float>& activations,
                  const std::function<bool()>& shouldCancel = {});

    //== exposed for the tests ================================================

    /** The tempo grid, in frames per beat, for the parameters above. */
    const std::vector<int>& intervals();
}
