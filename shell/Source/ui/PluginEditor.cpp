#include "PluginEditor.h"
#include "PluginProcessor.h"

bool RiffsheetAudioProcessorEditor::SinglePageBrowser::pageAboutToLoad (const juce::String& newURL)
{
    if (newURL.startsWith (juce::WebBrowserComponent::getResourceProviderRoot()))
        return true;

    // External links open in the user's real browser instead of taking over the
    // plugin window.
    if (newURL.startsWithIgnoreCase ("http://") || newURL.startsWithIgnoreCase ("https://"))
        juce::URL (newURL).launchInDefaultBrowser();

    return false;
}

RiffsheetAudioProcessorEditor::RiffsheetAudioProcessorEditor (RiffsheetAudioProcessor& p)
    : AudioProcessorEditor (&p),
      proc (p),
      bridge (p),
      webView (bridge.configure (juce::WebBrowserComponent::Options{}
                                     .withBackend (juce::WebBrowserComponent::Options::Backend::webview2)
                                     .withWinWebView2Options (
                                         juce::WebBrowserComponent::Options::WinWebView2{}
                                             .withUserDataFolder (juce::File::getSpecialLocation (
                                                 juce::File::tempDirectory)))
                                     .withKeepPageLoadedWhenBrowserIsHidden()))
{
    addAndMakeVisible (webView);

    bridge.attachWebView (&webView);

    // Loading the resource-provider root (rather than a file:// URL) is what
    // gives the page a real, consistent origin - fetch, Workers and Web Audio
    // all depend on it.
    //
    // ?debug=1 asks the web app for its engine test panel instead of the normal
    // UI. Set RIFFSHEET_DEBUG=1 in the environment to get it.
    auto url = juce::WebBrowserComponent::getResourceProviderRoot();

    if (juce::SystemStats::getEnvironmentVariable ("RIFFSHEET_DEBUG", {}).getIntValue() != 0)
        url += "?debug=1";

    webView.goToURL (url);

    // Resizing, BASAMAK-style: a real resizable editor with a corner gripper,
    // sane limits, and a size that survives closing the window and reopening it.
    //
    // Read the remembered size BEFORE touching the constrainer. setResizeLimits()
    // constrains the component immediately, which fires resized() while the
    // editor is still 0x0 - that snaps it to the minimum and, because resized()
    // writes the size back to the processor, would overwrite the very value we
    // are about to restore.
    const auto stored = proc.getEditorSize();
    const auto restoredWidth  = juce::jlimit (minEditorWidth,  4096, stored.x > 0 ? stored.x : defaultEditorWidth);
    const auto restoredHeight = juce::jlimit (minEditorHeight, 2600, stored.y > 0 ? stored.y : defaultEditorHeight);

    // ASKING FOR THE DESIGN SIZE ONLY WHERE ASKING WORKS.
    //
    // preferredMinEditorWidth/Height is the size the face is drawn at (scale 1),
    // and in the standalone it is a real minimum: the app owns its window, the
    // OS enforces the constrainer, and nothing can drag it smaller. Inside a
    // host it is a REQUEST that REAPER in particular declines - it shrinks its FX
    // frame regardless and clips whatever the plugin claimed - so a plugin editor
    // still hands over the low hard floor and lets the one-proportion law do the
    // work: below the base size the face scales down whole rather than breaking.
    // Either way both numbers are reported to the page (getShellInfo), which is
    // what lets webcore tell "the user made it small" from "this is the floor".
    const auto standalone = proc.wrapperType == juce::AudioProcessor::wrapperType_Standalone;
    const auto floorWidth  = standalone ? preferredMinEditorWidth  : minEditorWidth;
    const auto floorHeight = standalone ? preferredMinEditorHeight : minEditorHeight;

    setResizable (true, true);
    setResizeLimits (floorWidth, floorHeight, 4096, 2600);
    setSize (juce::jmax (floorWidth, restoredWidth), juce::jmax (floorHeight, restoredHeight));
}

RiffsheetAudioProcessorEditor::~RiffsheetAudioProcessorEditor()
{
    // Member destruction is reverse declaration order, so webView would die
    // before bridge. Drain bridge workers and invalidate JUCE completions here,
    // while the WebView's native-function provider is still alive.
    bridge.shutdown();
}

void RiffsheetAudioProcessorEditor::processorStateRestored()
{
    // A full page refresh is intentional: boot reads getPersistedState() before
    // it can schedule any save, so stale JS cannot overwrite the state the host
    // has just loaded. An event alone would leave old code/state alive until it
    // chose to handle the event.
    webView.refresh();
}

void RiffsheetAudioProcessorEditor::paint (juce::Graphics& g)
{
    // Only ever visible for the instant before the WebView paints.
    g.fillAll (juce::Colour (0xff14161a));
}

bool RiffsheetAudioProcessorEditor::isInterestedInFileDrag (const juce::StringArray& files)
{
    const auto symbolicAndPrinted = juce::String (
        "*.mid;*.midi;*.musicxml;*.mxl;*.xml;*.gp;*.gp3;*.gp4;*.gp5;*.gpx;*.gp7;"
        "*.pdf;*.png;*.jpg;*.jpeg;*.tif;*.tiff;*.bmp;*.omr;*.riffsheet");
    const juce::WildcardFileFilter accepted (
        proc.getPcmStore().getReadableWildcards() + ";" + symbolicAndPrinted,
        {}, "Riffsheet inputs");

    for (const auto& path : files)
        if (accepted.isFileSuitable (juce::File (path)))
            return true;

    return false;
}

void RiffsheetAudioProcessorEditor::filesDropped (const juce::StringArray& files, int, int)
{
    bridge.notifyFilesDropped (files);
}

void RiffsheetAudioProcessorEditor::resized()
{
    // The WebView is the entire editor and must track every intermediate size
    // during a live drag, or the host is left painting stale pixels in the gap.
    const auto bounds = getLocalBounds();

    if (webView.getBounds() != bounds)
    {
        webView.setBounds (bounds);

        // WKWebView can be lazy about repainting after a frame change during a
        // fast drag. Telling the page its viewport moved costs nothing and makes
        // any layout that listens for it settle immediately.
        webView.emitEventIfBrowserIsVisible ("viewportResized",
                                             juce::JSON::parse ("{\"width\":" + juce::String (bounds.getWidth())
                                                                + ",\"height\":" + juce::String (bounds.getHeight()) + "}"));
    }

    // Remember it on the processor so reopening the window (or reloading the
    // session) comes back the same size.
    proc.setEditorSize ({ getWidth(), getHeight() });
}
