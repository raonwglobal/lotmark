/** Shared project helpers */
import { calculateGrade } from '../grading.js';

export function parseGps(data) {
  if (data.gps?.raw && (data.gps.lat == null || data.gps.lng == null)) {
    const parts = String(data.gps.raw).split(',').map(v => parseFloat(v.trim()));
    if (parts.length >= 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
      data.gps = { ...data.gps, lat: parts[0], lng: parts[1] };
    }
  }
  return data;
}

export function applyGrade(data) {
  const { score, grade, reason } = calculateGrade(data);
  data.score = score;
  data.grade = grade;
  data.gradeReason = reason;
  data.lastVerifiedDate = new Date();
  return data;
}
