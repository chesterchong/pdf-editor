import { useEffect, useRef, useState } from "react";
import "./ColorPicker.css";

const PALETTE = [
  ["#000000", "#434343", "#666666", "#999999", "#b7b7b7", "#cccccc", "#d9d9d9", "#efefef", "#f3f3f3", "#ffffff"],
  ["#980000", "#ff0000", "#ff9900", "#ffff00", "#00ff00", "#00ffff", "#4a86e8", "#0000ff", "#9900ff", "#ff00ff"],
  ["#e6b8af", "#f4cccc", "#fce5cd", "#fff2cc", "#d9ead3", "#d0e0e3", "#c9daf8", "#cfe2f3", "#d9d2e9", "#ead1dc"],
  ["#dd7e6b", "#ea9999", "#f9cb9c", "#ffe599", "#b6d7a8", "#a2c4c9", "#a4c2f4", "#9fc5e8", "#b4a7d6", "#d5a6bd"],
  ["#cc4125", "#e06666", "#f6b26b", "#ffd966", "#93c47d", "#76a5af", "#6d9eeb", "#6fa8dc", "#8e7cc3", "#c27ba0"],
  ["#a61c00", "#cc0000", "#e69138", "#f1c232", "#6aa84f", "#45818e", "#3c78d8", "#3d85c6", "#674ea7", "#a64d79"],
  ["#85200c", "#990000", "#b45f06", "#bf9000", "#38761d", "#134f5c", "#1155cc", "#0b5394", "#351c75", "#741b47"],
  ["#5b0f00", "#660000", "#783f04", "#7f6000", "#274e13", "#0c343d", "#1c4587", "#073763", "#20124d", "#4c1130"],
];
const STANDARD = ["#000000", "#ffffff", "#4285f4", "#ea4335", "#fbbc04", "#34a853", "#ff6d01", "#46bdc6"];

type EyeDropperCtor = new () => { open(): Promise<{ sRGBHex: string }> };

function isLight(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 > 186;
}

type Props = {
  value: string;
  defaultValue: string;
  onChange: (color: string) => void;
  label: string;
};

export function ColorPicker({ value, defaultValue, onChange, label }: Props) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState<string[]>([]);
  const root = useRef<HTMLDivElement>(null);
  const native = useRef<HTMLInputElement>(null);
  const eyeDropper = (window as Window & { EyeDropper?: EyeDropperCtor }).EyeDropper;

  useEffect(() => {
    if (!open) return;
    function onDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(color: string) {
    onChange(color.toLowerCase());
    setOpen(false);
  }

  function addCustom(color: string) {
    const c = color.toLowerCase();
    setCustom((list) => (list.includes(c) ? list : [...list, c]).slice(-10));
    pick(c);
  }

  const swatch = (color: string, key: string) => {
    const selected = color === value.toLowerCase();
    return (
      <button
        key={key}
        type="button"
        className={`cp-swatch ${selected ? "selected" : ""} ${isLight(color) ? "light" : ""}`}
        style={{ background: color }}
        aria-label={color}
        aria-pressed={selected}
        onClick={() => pick(color)}
      />
    );
  };

  return (
    <div className="cp" ref={root}>
      <button
        type="button"
        className="cp-trigger"
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="cp-trigger-swatch" style={{ background: value }} />
      </button>
      {open && (
        <div className="cp-pop" role="dialog" aria-label={label}>
          <button type="button" className="cp-reset" onClick={() => pick(defaultValue)}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                fill="currentColor"
                d="M16.56 8.94 7.62 0 6.21 1.41l2.38 2.38-5.15 5.15a1.49 1.49 0 0 0 0 2.12l5.5 5.5c.29.29.68.44 1.06.44s.77-.15 1.06-.44l5.5-5.5c.59-.58.59-1.53 0-2.12zM5.21 10 10 5.21 14.79 10H5.21zM19 11.5s-2 2.17-2 3.5c0 1.1.9 2 2 2s2-.9 2-2c0-1.33-2-3.5-2-3.5zM2 20h20v4H2v-4z"
              />
            </svg>
            Reset
          </button>
          <div className="cp-grid">
            {PALETTE.map((row, r) => row.map((c, i) => swatch(c, `${r}-${i}`)))}
          </div>
          <div className="cp-heading">Standard</div>
          <div className="cp-grid">{STANDARD.map((c, i) => swatch(c, `s-${i}`))}</div>
          <div className="cp-heading">Custom</div>
          <div className="cp-grid">
            {custom.map((c, i) => swatch(c, `c-${i}`))}
            <button
              type="button"
              className="cp-icon"
              aria-label="Add custom color"
              title="Add custom color"
              onClick={() => native.current?.click()}
            >
              <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            {eyeDropper && (
              <button
                type="button"
                className="cp-icon"
                aria-label="Pick a color from the screen"
                title="Pick a color from the screen"
                onClick={async () => {
                  try {
                    const result = await new eyeDropper().open();
                    addCustom(result.sRGBHex);
                  } catch {
                    // Cancelled.
                  }
                }}
              >
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M20.71 5.63l-2.34-2.34a1 1 0 0 0-1.41 0l-3.12 3.12-1.93-1.91-1.41 1.41 1.42 1.42L3 16.25V21h4.75l8.92-8.92 1.42 1.42 1.41-1.41-1.92-1.92 3.12-3.12c.4-.4.4-1.03.01-1.42zM6.92 19 5 17.08l8.06-8.06 1.92 1.92L6.92 19z"
                  />
                </svg>
              </button>
            )}
            <input
              ref={native}
              type="color"
              className="cp-native"
              value={value}
              onChange={(event) => addCustom(event.target.value)}
              aria-hidden="true"
              tabIndex={-1}
            />
          </div>
        </div>
      )}
    </div>
  );
}
