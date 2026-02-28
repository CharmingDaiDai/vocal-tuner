/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg:       '#0d1117',
        'bg-card':'#161b22',
        border:   '#30363d',
        text:     '#c9d1d9',
        'text-muted': '#8b949e',
        accent:   '#58a6ff',
        good:     '#3fb950',
        warn:     '#d29922',
        bad:      '#f85149',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'monospace'],
      },
    },
  },
  plugins: [],
}
