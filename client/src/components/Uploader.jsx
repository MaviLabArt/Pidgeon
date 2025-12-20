import React, { useRef } from "react";
import mediaUpload, { UPLOAD_ABORTED_ERROR_MSG } from "@/services/mediaUpload";

export function Uploader({
  children,
  onUploadSuccess,
  onUploadStart,
  onUploadEnd,
  onUploadProgress,
  onError,
  onUploadError,
  accept = "image/*,video/*",
  className,
  serviceUrl,
  backend = "blossom",
  blossomServers
}) {
  const inputRef = useRef(null);
  const emitError = (msg) => {
    onError?.(msg);
    onUploadError?.(msg);
  };

  const handleFileChange = async (event) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    if (!window?.nostr?.signEvent || !window?.nostr?.getPublicKey) {
      emitError("Connect a Nostr signer to upload");
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    const abortControllers = new Map();

    for (const file of files) {
      const abortController = new AbortController();
      abortControllers.set(file, abortController);
      onUploadStart?.(file, () => abortController.abort());
    }

    for (const file of files) {
      const abortController = abortControllers.get(file);
      try {
        const result = await mediaUpload.upload(file, {
          onProgress: (p) => onUploadProgress?.(file, p),
          signal: abortController?.signal,
          serviceUrl,
          backend,
          blossomServers,
        });
        onUploadSuccess?.(result);
        onUploadEnd?.(file);
      } catch (err) {
        const msg = err?.message || "Upload failed";
        if (msg !== UPLOAD_ABORTED_ERROR_MSG) {
          console.error("Upload error", msg);
          emitError(msg);
        }
        onUploadEnd?.(file);
      }
    }

    if (inputRef.current) {
      inputRef.current.value = "";
    }
  };

  const handleClick = () => {
    if (inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.click();
    }
  };

  return (
    <div className={className}>
      <div onClick={handleClick}>{children}</div>
      <input
        ref={inputRef}
        type="file"
        multiple
        onChange={handleFileChange}
        accept={accept}
        className="hidden"
      />
    </div>
  );
}
