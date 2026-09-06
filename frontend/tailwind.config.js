/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Semantic surface ramp. The app is dark-only; these name the roles the old
        // code spelled out as raw gray-9xx everywhere, so a change lands in one place.
        canvas: "#0a0b0d",
        surface: {
          DEFAULT: "#111318",
          raised: "#161920",
          overlay: "#1c2029",
        },
        hairline: {
          DEFAULT: "#23262f",
          strong: "#2e323d",
        },
        severity: {
          critical: "#f43f5e",
          notable: "#f59e0b",
          minor: "#84cc16",
          none: "#6b7280",
        },
        // Price direction. Kept distinct from severity so a green "up" tick and a
        // green "minor" dot never get read as the same signal.
        up: "#22c55e",
        down: "#f43f5e",
        accent: {
          DEFAULT: "#6366f1",
          soft: "#4338ca",
        },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in-right": {
          from: { opacity: "0", transform: "translateX(16px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "flash-up": {
          "0%": { backgroundColor: "rgba(34,197,94,0.18)" },
          "100%": { backgroundColor: "transparent" },
        },
        "flash-down": {
          "0%": { backgroundColor: "rgba(244,63,94,0.18)" },
          "100%": { backgroundColor: "transparent" },
        },
        "pulse-ring": {
          "0%": { boxShadow: "0 0 0 0 rgba(34,197,94,0.5)" },
          "70%": { boxShadow: "0 0 0 6px rgba(34,197,94,0)" },
          "100%": { boxShadow: "0 0 0 0 rgba(34,197,94,0)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.15s ease-out",
        "slide-up": "slide-up 0.18s ease-out",
        "slide-in-right": "slide-in-right 0.2s ease-out",
        "flash-up": "flash-up 1s ease-out",
        "flash-down": "flash-down 1s ease-out",
        "pulse-ring": "pulse-ring 2s ease-out infinite",
      },
    },
  },
  plugins: [],
};
