import React from "react";
import EmojiPickerReact, { EmojiStyle, SuggestionMode, Theme } from "emoji-picker-react";

export default function EmojiPicker({ onEmojiClick, width = 350, height = 380 }) {
  const [docTheme, setDocTheme] = React.useState(() => {
    try {
      return document.documentElement?.getAttribute("data-theme") || "dark";
    } catch {
      return "dark";
    }
  });

  React.useEffect(() => {
    try {
      const el = document.documentElement;
      const observer = new MutationObserver(() => {
        setDocTheme(el.getAttribute("data-theme") || "dark");
      });
      observer.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
      return () => observer.disconnect();
    } catch {
      return undefined;
    }
  }, []);

  const isLight = String(docTheme || "").toLowerCase() === "light";

  return (
    <EmojiPickerReact
      theme={isLight ? Theme.LIGHT : Theme.DARK}
      width={width}
      height={height}
      autoFocusSearch={false}
      emojiStyle={EmojiStyle.NATIVE}
      suggestedEmojisMode={SuggestionMode.FREQUENT}
      skinTonesDisabled
      previewConfig={{ showPreview: false }}
      style={
        {
          "--epr-bg-color": isLight ? "var(--ps-surface)" : "var(--ps-bg)",
          "--epr-category-label-bg-color": isLight ? "var(--ps-surface)" : "var(--ps-bg)",
          "--epr-text-color": "var(--ps-text)",
          "--epr-hover-bg-color": isLight ? "rgba(31, 27, 22, 0.06)" : "rgba(255, 255, 255, 0.06)",
          "--epr-focus-bg-color": isLight ? "rgba(31, 27, 22, 0.08)" : "rgba(255, 255, 255, 0.08)",
          "--epr-picker-border-color": "var(--ps-border)",
          "--epr-search-input-bg-color": isLight ? "rgba(31, 27, 22, 0.06)" : "rgba(255, 255, 255, 0.06)",
          "--epr-search-input-border-color": "var(--ps-border)",
          "--epr-highlight-color": "var(--ps-accent)",
        }
      }
      onEmojiClick={(data, event) => onEmojiClick?.(data?.emoji, event)}
    />
  );
}
