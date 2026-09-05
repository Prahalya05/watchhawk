/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        severity: {
          critical: "#dc2626",
          notable: "#d97706",
          minor: "#65a30d",
          none: "#6b7280",
        },
      },
    },
  },
  plugins: [],
};
