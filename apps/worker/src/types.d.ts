declare module 'ua-parser-js' {
  class UAParser {
    constructor(ua?: string);
    getResult(): {
      browser: { name?: string; version?: string };
      os: { name?: string; version?: string };
      device: { type?: string; model?: string; vendor?: string };
    };
  }
  export default UAParser;
}

declare module 'geoip-lite' {
  export interface Lookup {
    range: [number, number];
    country: string;
    region: string;
    timezone: string;
    city: string;
    ll: [number, number];
    metro: number;
    area: number;
  }
  export function lookup(ip: string): Lookup | null;
}
