import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#10151F",
        surface: "#1B2330",
        "surface-alt": "#232D3E",
        gold: "#D8A94E",
        "gold-dim": "#8A6E38",
        coral: "#E2664B",
        "text-1": "#EDEFF3",
        "text-2": "#9CA6B8",
        "text-3": "#5E6B80",
        green: "#4F9E6E"
      },
      fontFamily: {
        display: ["Fraunces", "serif"],
        sans: ["Inter", "sans-serif"]
      }
    }
  },
  plugins: []
};

export default config;
