import { Counter, fetchText } from "../counter";

const WMO: Record<number, string> = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 71: "light snow", 73: "snow", 75: "heavy snow", 80: "rain showers", 81: "rain showers",
  82: "violent showers", 95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with hail",
};

export async function getWeather(c: Counter, city: string) {
  const geo = JSON.parse(await fetchText(c, `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`));
  const p = geo.results?.[0];
  if (!p) return { error: `could not find city "${city}"` };
  const f = JSON.parse(await fetchText(c,
    `https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=Asia%2FKolkata&forecast_days=1`));
  const cur = f.current, d = f.daily;
  return {
    place: `${p.name}, ${p.admin1 ?? p.country}`,
    now: `${cur.temperature_2m}°C (feels ${cur.apparent_temperature}°C), ${WMO[cur.weather_code] ?? "unknown"}, humidity ${cur.relative_humidity_2m}%, wind ${cur.wind_speed_10m} km/h`,
    today: `${d.temperature_2m_min[0]}-${d.temperature_2m_max[0]}°C, ${WMO[d.weather_code[0]] ?? "unknown"}, rain chance ${d.precipitation_probability_max[0]}%`,
  };
}
