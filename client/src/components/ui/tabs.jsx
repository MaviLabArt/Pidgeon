import React, { createContext, useContext, useState } from "react";
import { cn } from "@/lib/utils";

const TabsContext = createContext();

export function Tabs({ defaultValue, value, onValueChange, children, className }) {
  const [internal, setInternal] = useState(defaultValue);
  const current = value !== undefined ? value : internal;

  function setValue(val) {
    setInternal(val);
    onValueChange?.(val);
  }

  return (
    <TabsContext.Provider value={{ value: current, setValue }}>
      <div className={cn("flex flex-col gap-2", className)}>{children}</div>
    </TabsContext.Provider>
  );
}

function useTabs() {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("Tabs components must be used within <Tabs>");
  return ctx;
}

export function TabsList({ className, ...props }) {
  return <div className={cn("inline-flex items-center gap-1 rounded-2xl bg-slate-900 p-1 ring-1 ring-white/10", className)} {...props} />;
}

export function TabsTrigger({ value, className, children, ...props }) {
  const { value: active, setValue } = useTabs();
  const isActive = active === value;
  return (
    <button
      type="button"
      onClick={() => setValue(value)}
      className={cn(
        "rounded-xl px-3 py-1.5 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400",
        isActive ? "bg-slate-950 text-white ring-1 ring-white/10" : "text-white/60 hover:text-white hover:bg-white/5",
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function TabsContent({ value, className, children, ...props }) {
  const { value: active } = useTabs();
  if (active !== value) return null;
  return (
    <div className={className} {...props}>
      {children}
    </div>
  );
}
