import { describe, expect, it } from 'vitest'
import { clockTicks, displayUnit, formatClock } from './units'

describe('displayUnit', () => {
  it('converts distance, elevation, speed, and pace for imperial', () => {
    expect(displayUnit('m', 'distance_m', 'imperial', ['run']).label).toBe('mi')
    expect(5000 * displayUnit('m', 'distance_m', 'imperial', ['run']).factor).toBeCloseTo(3.107, 3)
    expect(176 * displayUnit('m', 'elevation_gain_m', 'imperial', ['run']).factor).toBeCloseTo(577.4, 1)
    expect(3 * displayUnit('m/s', 'speed', 'imperial', ['run']).factor).toBeCloseTo(6.71, 2)
    const pace = displayUnit('s/km', 'avg_pace_s_per_km', 'imperial', ['run'])
    expect(pace).toMatchObject({ label: 'min/mi', format: 'clock', reversed: true })
    expect(formatClock(420 * pace.factor)).toBe('11:16')
  })

  it('uses metric units when asked', () => {
    expect(displayUnit('m', 'distance_m', 'metric', ['run'])).toMatchObject({ label: 'km', factor: 0.001 })
    expect(displayUnit('s/km', 'pace_s_per_km', 'metric', ['run']).factor).toBe(1)
  })

  it('labels cadence by sport', () => {
    expect(displayUnit('cadence', 'avg_cadence', 'imperial', ['run', 'hike']).label).toBe('spm')
    expect(displayUnit('cadence', 'avg_cadence', 'imperial', ['ride']).label).toBe('rpm')
    expect(displayUnit('cadence', 'avg_cadence', 'imperial', ['run', 'ride']).label).toBe('spm / rpm')
  })
})

describe('clock formatting', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatClock(59.6)).toBe('1:00')
    expect(formatClock(676)).toBe('11:16')
    expect(formatClock(3725)).toBe('1:02:05')
  })

  it('picks whole-unit tick steps', () => {
    expect(clockTicks(600, 720).text).toEqual(['10:00', '10:30', '11:00', '11:30', '12:00'])
    expect(clockTicks(660, 860).text).toEqual(['11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00'])
    expect(clockTicks(0, 3600).vals).toEqual([0, 600, 1200, 1800, 2400, 3000, 3600])
  })
})
