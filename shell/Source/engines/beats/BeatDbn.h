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
    /** THE CORE candidate bar lengths, one HMM each, highest path probability wins.

        {3, 4} is madmom's and beat_this's default pair, and it is the set the
        parity goldens in test/golden were captured with - they record it under
        `dbn.beatsPerBar`, and the whole worth of those files is that they came
        out of the Python reference before any of this C++ existed.

        Do not "update the goldens" to make a wider set pass. They cannot be
        regenerated from this repository - they need beat_this 1.1.0, madmom
        0.17.dev0 and torch under Python 3.10 - and rewriting them from our own
        output would turn a parity test into a recording of whatever we last did. */
    constexpr int    kBeatsPerBarOptions[] = { 3, 4 };

    /** THE ODD METRES, reachable only by earning it. 6/8, 5/4 and 7/8 are real
        material for a riff tool and the core pair cannot represent them at all.

        WHY THEY ARE NOT SIMPLY IN THE LIST ABOVE. Putting {2,5,6,7} in
        kBeatsPerBarOptions was tried and reverted, and the reason is structural,
        not a tuning accident. `track` picks the winner by raw Viterbi path
        probability, and those numbers are NOT comparable across bar lengths: a
        bar of N beats is forced to spend exactly one downbeat label per N beats,
        and log(downbeat activation) is a large negative number wherever the
        network heard no downbeat. So on material with no downbeat information -
        a held bass note, four seconds of one pitch - the likelihood rises
        monotonically with N for a reason that has nothing to do with metre, and
        the decoder will buy the longer bar by ALSO re-timing to a slower tempo.
        Measured: the held-note fixture went from 5 beats to 3. The widening did
        not merely allow odd metres, it lost beats on weak material.

        THE FIX IS IN WHAT IS COMPARED, not in the list. An odd bar length is
        adopted only when the downbeat column itself says so, measured
        independently of the path probability by `downbeatEvidence` in the .cpp:
        the mean log downbeat activation at the beats a bar of N would call
        downbeats, minus the mean at the beats it would not. That statistic is
        scale-free in N - a bar length that lines up with real accents scores
        high whatever its length, and one that does not scores about zero - which
        is exactly the comparison the raw likelihood cannot make.

        The core pair is decoded first and unconditionally, by the same code as
        before. An odd candidate replaces it only if it clears all four gates in
        `track`, so when nothing qualifies the answer is bit-identical to what
        this file produced with {3,4} alone. That is what keeps the goldens
        honest rather than merely green. */
    constexpr int    kExtendedBeatsPerBarOptions[] = { 2, 5, 6, 7 };

    /** GATE 1: how much downbeat evidence a bar length needs before it is even a
        candidate, in nats of mean log activation. Pure noise scores about 0; a
        clean accent pattern scores several. */
    constexpr double kDownbeatEvidenceMin = 1.5;

    /** GATE 2: and how far it must beat the core winner's own evidence by, so a
        tie or a rounding difference never moves the metre. */
    constexpr double kDownbeatEvidenceMargin = 0.75;

    /** GATE 3: the minimum number of complete bars the evidence must be measured
        over. Without it a 5-beat take "supports" a bar of 5 perfectly, because
        every residue class has exactly one member and one of them is necessarily
        the loudest. This is the gate that protects sparse material. */
    constexpr int    kMinBarsForEvidence = 3;

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
