import React from "react";
import EmojiPickerReact, { EmojiStyle, SuggestionMode, Theme } from "emoji-picker-react";

export default function EmojiPicker({ onEmojiClick, width = 350, height = 380 }) {
  return (
    <EmojiPickerReact
      theme={Theme.DARK}
      width={width}
      height={height}
      autoFocusSearch={false}
      emojiStyle={EmojiStyle.NATIVE}
      suggestedEmojisMode={SuggestionMode.FREQUENT}
      skinTonesDisabled
      previewConfig={{ showPreview: false }}
      style={
        {
          "--epr-bg-color": "rgba(2, 6, 23, 1)",
          "--epr-category-label-bg-color": "rgba(2, 6, 23, 1)",
          "--epr-text-color": "rgba(248, 250, 252, 0.92)",
          "--epr-hover-bg-color": "rgba(255, 255, 255, 0.06)",
          "--epr-focus-bg-color": "rgba(255, 255, 255, 0.08)",
          "--epr-picker-border-color": "rgba(255, 255, 255, 0.10)",
          "--epr-search-input-bg-color": "rgba(255, 255, 255, 0.06)",
          "--epr-search-input-border-color": "rgba(255, 255, 255, 0.10)",
          "--epr-highlight-color": "rgba(99, 102, 241, 0.9)",
        }
      }
      onEmojiClick={(data, event) => onEmojiClick?.(data?.emoji, event)}
    />
  );
}
