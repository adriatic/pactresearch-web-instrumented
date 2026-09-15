"use client";

// The composer's prompt input. Two things moved out of here:
//
// - The Run button now lives in the global header (Workspace.tsx), acting
//   on whatever discussion is selected and whatever text is in its
//   composer. That makes the header button the sole run trigger, which
//   costs nothing: Enter inside a <textarea> inserts a newline and has
//   never submitted the surrounding form, so the old <form> wrapper had
//   no remaining way to be submitted once its only submit button left.
//   It's gone rather than left as dead markup.
//
// - The textarea's own native resize grip is disabled (resize: "none") in
//   favor of the real draggable divider between this panel and the
//   discussion content below it (the vertical Group in Workspace.tsx).
//   Two competing resize affordances in the same corner is worse than
//   one, and the divider is the one that actually reflows the layout
//   rather than just overflowing a fixed-height region.
//
// The real rich-text/mixed text-image composer rebuild (3.13 decision 1)
// is a separate, standalone prototype outside pact-web — not this
// component.

export function Composer({
  promptText,
  setPromptText,
}: {
  promptText: string;
  setPromptText: (value: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        padding: 8,
        boxSizing: "border-box",
      }}
    >
      <textarea
        aria-label="Prompt"
        value={promptText}
        onChange={(e) => setPromptText(e.target.value)}
        style={{
          flex: 1,
          minHeight: 0,
          width: "100%",
          resize: "none",
          boxSizing: "border-box",
        }}
      />
    </div>
  );
}
