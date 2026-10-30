// Validated categorical palette (8 slots, fixed order) and chart chrome, light and dark.
// Validated with the dataviz skill's validate_palette.js: all hard gates pass in both modes on
// adjacent pairs; the first three slots also pass all-pairs (scatter). Every slot clears 3:1
// contrast on its mode's surface: light slots 3-5 (aqua, yellow, magenta) are darker steps of the
// reference hues, chosen so the light set keeps worst adjacent CVD ΔE 10.0 / normal-vision 17.6.

export interface ChartTheme {
  surface: string
  textPrimary: string
  textSecondary: string
  muted: string
  grid: string
  baseline: string
  series: string[]
}

export const LIGHT: ChartTheme = {
  surface: '#fcfcfb',
  textPrimary: '#0b0b0b',
  textSecondary: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  baseline: '#c3c2b7',
  series: ['#2a78d6', '#eb6834', '#01a773', '#bd7f03', '#da6f98', '#008300', '#6250d6', '#e34948'],
}

export const DARK: ChartTheme = {
  surface: '#1a1a19',
  textPrimary: '#f0efec',
  textSecondary: '#c3c2b7',
  muted: '#898781',
  grid: '#2c2c2a',
  baseline: '#383835',
  series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
}

/** Scatter plots can only keep this many series distinguishable (all-pairs validation). */
export const SCATTER_SERIES_LIMIT = 3

export function currentTheme(): ChartTheme {
  const forced = document.documentElement.dataset.theme
  if (forced === 'dark') return DARK
  if (forced === 'light') return LIGHT
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? DARK : LIGHT
}
