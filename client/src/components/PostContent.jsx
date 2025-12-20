import { extractImageUrls, isImageUrl, tokenizeTextWithUrls } from "@/utils/contentUrls.js";

import React from "react";

function PostContentImpl({ content, maxInlineImages = 6, stopClickPropagation = true }) {
  const text = String(content || "");
  if (!text.trim()) return null;

  const lines = text.split(/\n/);

  return (
    <div className="space-y-2">
      {lines.map((line, lineIdx) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={`gap-${lineIdx}`} className="h-2" />;

        const tokens = tokenizeTextWithUrls(line);
        const inlineImages = extractImageUrls(line, { limit: maxInlineImages });
        const standaloneImage =
          tokens.length === 1 &&
          tokens[0]?.type === "url" &&
          isImageUrl(tokens[0]?.value) &&
          trimmed === tokens[0]?.value;

        if (standaloneImage) {
          return (
            <div key={`img-${lineIdx}`} className="overflow-hidden rounded-2xl ring-1 ring-white/10 bg-black/20">
              <img src={tokens[0].value} alt="" className="h-auto w-full object-cover" loading="lazy" />
            </div>
          );
        }

        return (
          <div key={`line-${lineIdx}`} className="space-y-2">
            <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[15px] leading-relaxed text-white/80">
              {tokens.map((token, idx) => {
                if (!token?.value) return null;
                if (token.type === "url") {
                  const href = token.value;
                  return (
                    <a
                      key={`${lineIdx}-${idx}`}
                      href={href}
                      className="underline decoration-white/30 underline-offset-4 hover:decoration-white/70"
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => {
                        if (stopClickPropagation) e.stopPropagation();
                      }}
                    >
                      {href}
                    </a>
                  );
                }
                return <span key={`${lineIdx}-${idx}`}>{token.value}</span>;
              })}
            </div>
            {inlineImages.length > 0 ? (
              <div className="space-y-2">
                {inlineImages.map((url) => (
                  <div key={url} className="overflow-hidden rounded-2xl ring-1 ring-white/10 bg-black/20">
                    <img src={url} alt="" className="h-auto w-full object-cover" loading="lazy" />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export default React.memo(PostContentImpl);
