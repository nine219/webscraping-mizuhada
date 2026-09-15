import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        'bg-base':            '#f0f7ff',
        'bg-surface':         '#ffffff',
        'bg-sidebar':         '#0c4a6e',
        'bg-sidebar-hover':   '#075985',
        'bg-sidebar-active':  '#0369a1',
        'accent-primary':     '#0ea5e9',
        'accent-primary-lt':  '#7dd3fc',
        'accent-primary-dk':  '#0284c7',
        'accent-success':     '#10b981',
        'accent-warning':     '#f59e0b',
        'accent-danger':      '#ef4444',
        'text-primary':       '#0f172a',
        'text-secondary':     '#475569',
        'text-muted':         '#94a3b8',
        'text-on-dark':       '#f1f5f9',
        'border-base':        '#e2e8f0',
        'border-light':       '#f1f5f9',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'monospace'],
      },
      borderRadius: {
        'xl': '12px',
        '2xl': '16px',
      },
      boxShadow: {
        'sm':  '0 1px 2px 0 rgba(0,0,0,0.05)',
        'md':  '0 4px 6px -1px rgba(0,0,0,0.1)',
        'lg':  '0 10px 15px -3px rgba(0,0,0,0.1)',
        'chat': '0 20px 60px rgba(0,0,0,0.12)',
      },
    },
  },
  plugins: [],
};

export default config;
