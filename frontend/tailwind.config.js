/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: '#0E1230',
          50: '#F4F6FC',
          100: '#E3E7F5',
          200: '#C3CBEA',
          700: '#252B63',
          900: '#12163F',
          950: '#080A1F'
        },
        paper: {
          DEFAULT: '#F7F8FC',
          dark: '#0A0E27'
        },
        amber: {
          DEFAULT: '#1596C9',
          light: '#D6F1FB'
        },
        approve: {
          DEFAULT: '#3F7D58',
          light: '#D9EBE0'
        },
        reject: {
          DEFAULT: '#B33A3A',
          light: '#F3D8D8'
        }
      },
      fontFamily: {
        display: ['"Fraunces"', 'serif'],
        sans: ['"IBM Plex Sans"', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'monospace']
      },
      boxShadow: {
        panel: '0 1px 2px rgba(18,22,63,0.06), 0 8px 24px rgba(18,22,63,0.08)'
      }
    }
  },
  plugins: []
};