#pragma once
#include <JuceHeader.h>
#include "NativeBridge.h"

class RiffsheetAudioProcessor;

/**
    The whole editor is one WebView. There is no native UI beyond the window -
    every pixel comes from the webcore bundle.
*/
class RiffsheetAudioProcessorEditor final : public juce::AudioProcessorEditor,
                                            public juce::FileDragAndDropTarget
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

private:
    /** Keeps the WebView on our own single page: a stray link or a redirect
        must not be able to navigate the plugin UI somewhere else. */
    struct SinglePageBrowser final : juce::WebBrowserComponent
    {
        using juce::WebBrowserComponent::WebBrowserComponent;
        bool pageAboutToLoad (const juce::String& newURL) override;
    };

    // 900x600 is the size the UI is DESIGNED for, but it is not the hard floor.
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
    static constexpr int minEditorWidth  = 360;
    static constexpr int minEditorHeight = 280;

    // What a FRESH instance opens at - nothing else. A user who has resized the
    // window keeps their size (it is persisted on the processor and restored
    // below), so changing these numbers only affects a first open.
    //
    // 1100x700 rather than the old 1180x760: field feedback was that the first
    // window was bigger than it needed to be. 1100x700 is the measured "just
    // enough" - transport row + a few bars of staff, note names and tab all
    // visible without scrolling - and it still clears the 900x600 layout floor
    // with room to spare. webcore's design target is unchanged; the layout is
    // fluid either way (see BRIDGE.md section 1b).
    static constexpr int defaultEditorWidth  = 1100;
    static constexpr int defaultEditorHeight = 700;

    RiffsheetAudioProcessor& proc;
    NativeBridge bridge;
    SinglePageBrowser webView;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (RiffsheetAudioProcessorEditor)
};
