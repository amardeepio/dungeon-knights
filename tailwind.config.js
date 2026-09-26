/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,jsx,ts,tsx}',
    './lib/**/*.js',
  ],
  // Preflight is off deliberately. It is a global reset — it would strip the margins, list bullets
  // and default borders that 22,400 lines of hand-written CSS in `public/` still rely on, and none
  // of that markup is being rewritten. Turning it on is a separate, deliberate change to the legacy
  // sheets, not a side effect of adopting Tailwind.
  corePlugins: { preflight: false },
  theme: {
    // The apex page's palette, promoted to the app's. These are the values `public/css/home.css`
    // uses, read out of it so there is one source rather than two that agree today.
    colors: {
      // One phosphor green on near-black. `accent` is the same value the CSS calls `--accent`.
      accent: {
        DEFAULT: '#00E58A',
        dim: '#0B7A4B',
        glow: 'rgba(0, 229, 138, 0.22)',
      },
      // The readout's own text ramp, brightest to dimmest.
      phosphor: {
        bright: '#D6FFE9',
        DEFAULT: '#8FA79B',
        dim: '#6E8F7E',
        faint: '#4E6B5C',
      },
      // Ink: the page, and the one filled surface (a button).
      ink: {
        DEFAULT: '#06080A',
        raised: '#0B0F11',
        onAccent: '#04120A',
      },
    },
    fontFamily: {
      // Mono is the whole voice of the apex: the wordmark, the body and the buttons are all set in
      // it, so there is no display/body split to keep in step. `ui` keeps the native fallback chain
      // for a platform that has JetBrains Mono, which is every Mac and most Linux boxes.
      mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      sans: ['Inter', 'system-ui', 'sans-serif'],
    },
    extend: {
      letterSpacing: {
        prompt: '2px',
        readout: '4px',
      },
    },
  },
  plugins: [],
};
