import React, { createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

const DialogContext = createContext({ open: false, onOpenChange: () => {} });

export function Dialog({ open = false, onOpenChange = () => {}, children }) {
  return (
    <DialogContext.Provider value={{ open, onOpenChange }}>
      {children}
    </DialogContext.Provider>
  );
}

function useDialog() {
  return useContext(DialogContext);
}

export function DialogContent({ className, children, ...props }) {
  const { open, onOpenChange } = useDialog();
  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm"
      onClick={() => onOpenChange(false)}
    >
      <div className="min-h-full px-4 py-6 flex items-start justify-center sm:items-center">
        <div
          role="dialog"
          aria-modal="true"
          className={cn(
            "w-full max-w-lg rounded-3xl bg-slate-900 text-white ring-1 ring-white/10 shadow-2xl",
            className
          )}
          onClick={(e) => e.stopPropagation()}
          {...props}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}

export function DialogHeader({ className, ...props }) {
  return <div className={cn("space-y-1.5 p-6", className)} {...props} />;
}

export function DialogFooter({ className, ...props }) {
  return <div className={cn("flex flex-col-reverse gap-2 p-6 pt-0 sm:flex-row sm:justify-end", className)} {...props} />;
}

export function DialogTitle({ className, ...props }) {
  return <h2 className={cn("font-display text-lg font-semibold leading-none tracking-tight", className)} {...props} />;
}

export function DialogDescription({ className, ...props }) {
  return <p className={cn("text-sm text-white/60", className)} {...props} />;
}
