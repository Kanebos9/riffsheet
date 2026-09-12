#pragma once
#include <JuceHeader.h>
#include "NativeBridge.h"

class RiffsheetAudioProcessor;

/**
    The whole editor is one WebView. There is no native UI beyond the window -
    every pixel comes from the webcore bundle.
*/
class RiffsheetAudioProcessorEditor final : public juce::AudioProcessorEditor,
                                            public juce::FileDragAndDropTarget,
                                            private juce::Timer
{
public:
    explicit RiffsheetAudioProcessorEditor (RiffsheetAudioProcessor&);
    ~RiffsheetAudioProcessorEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

    /** Called asynchronously by the processor after a host project/preset
        restore while this editor is already open. */
    void processorStateRestored();

    // OS drag-and-drop. The WebView usually swallows native drops (the page's
    // own HTML5 drop handler gets them instead. When JUCE does see one, this
    // fallback accepts the same universal format set as Open; NativeBridge
    // returns either durable decoded audio or bounded file bytes to the page.
    bool isInterestedInFileDrag (const juce::StringArray& files) override;
    void filesDropped (const juce::StringArray& files, int x, int y) override;

    //==============================================================================
    /** THE SIZE THE FACE IS DESIGNED AT - A REQUEST, NOT A RULE.

        These are the same two numbers as FACE_BASE_W x FACE_BASE_H in
        webcore/src/ui/faceScale.ts, and they have to be: under the
        one-proportion law the whole face is laid out at that size and scaled by
        ONE factor, min(1, viewportW/base, viewportH/base). At this size the
        factor is exactly 1 - every control is the size it was drawn as. Below it
        nothing reflows and nothing is dropped; the same picture is simply
        smaller, and small enough eventually means unreadable. So this is the
        size to ASK for, and the layout is required to survive being refused.

        1320 is measured, not chosen: it is the widest of the three chrome rows
        at its natural width, plus margin (see faceScale.ts for the measurement
        and the verify sweep that asserts it). 700 is three rows of chrome, the
        waveform strip, the roll and a sheet pane worth looking at.

        WHY IT IS ONLY A REQUEST. A plugin cannot set its own window size; it can
        only tell the host a minimum and hope. REAPER does not refuse a drag that
        would take its FX window below that minimum - it shrinks the frame anyway
        and CLIPS the editor - so demanding this in REAPER buys a clipped UI
        rather than a readable one. The floor actually handed to a plugin host is
        therefore minEditorWidth/Height below; this number is enforced only where
        it can be honoured (the standalone, which owns its own window) and
        REPORTED everywhere, through getShellInfo(), so webcore can tell "the user
        made the window small" from "this is as small as it goes". */
    static constexpr int preferredMinEditorWidth  = 1320;
    static constexpr int preferredMinEditorHeight = 700;

    // The hard floor, which is NOT the design size.
    //
    // REAPER does not refuse a drag that would take its FX window below the
    // plugin's minimum - it shrinks the frame anyway and CLIPS the editor, so
    // the page keeps its old layout and the user just loses the edges. Its FX
    // window also spends ~310px on the plug-in list and ~85px on the header, so
    // a 900px editor minimum means the window cannot go below ~1210x690 without
    // clipping. That is easy to hit and is exactly the bug reported.
    //
    // So the hard floor is set low and the layout is required to stay fluid
    // (see BRIDGE.md): shrinking then reflows instead of clipping.
    // Measured: REAPER's docked FX window spends ~232pt on the plug-in list, so
    // a 700pt-wide FX window leaves the editor only ~468pt. Anything above that
    // clips. 420x300 keeps the editor under REAPER's floor at realistic window
    // sizes; the CSS carries the burden of still looking right down there.
    // Measured by dragging REAPER's docked FX window to its own smallest size
    // (622x422): the plug-in list takes ~232pt and the header ~85pt, leaving the
    // editor ~390x337. The floor sits under that so REAPER can never clip us.
    //
    // PUBLIC because getShellInfo() reports it: the page has to be able to tell
    // "the user made the window this small" from "this is as small as it goes".
    static constexpr int minEditorWidth  = 360;
    static constexpr int minEditorHeight = 280;

private:
    void updateWebViewBounds();
    void timerCallback() override { updateWebViewBounds(); }

   #if JUCE_MAC
    juce::Rectangle<int> getHostVisibleBounds() const;
   #endif

    /** Keeps the WebView on our own single page: a stray link or a redirect
        must not be able to navigate the plugin UI somewhere else. */
    struct SinglePageBrowser final : juce::WebBrowserComponent
    {
        using juce::WebBrowserComponent::WebBrowserComponent;
        bool pageAboutToLoad (const juce::String& newURL) override;
    };

    // What a FRESH instance opens at - nothing else. A user who has resized the
    // window keeps their size (it is persisted on the processor and restored
    // below), so changing these numbers only affects a first open.
    //
    // THE DESIGN SIZE, EXACTLY. It used to be 1100x700, chosen when the layout
    // reflowed and any width was as good as any other; under the one-proportion
    // law a first open at 1100 wide is a first open at 0.93 scale - every control
    // 7% smaller than it was drawn, for no reason anybody could name. Opening at
    // the base size means the first thing a new user sees is the face at 1:1.
    static constexpr int defaultEditorWidth  = preferredMinEditorWidth;
    static constexpr int defaultEditorHeight = preferredMinEditorHeight;

    RiffsheetAudioProcessor& proc;
    NativeBridge bridge;
    SinglePageBrowser webView;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (RiffsheetAudioProcessorEditor)
};
