// react-native-zeroconf ships no TypeScript types; declare only the surface
// this app uses so `import Zeroconf from "react-native-zeroconf"` typechecks.

declare module "react-native-zeroconf" {
  export interface ZeroconfService {
    name: string;
    fullName: string;
    host: string;
    port: number;
    addresses: string[];
    txt: Record<string, string>;
  }

  export type ZeroconfImplType = "NSD" | "DNSSD";

  export default class Zeroconf {
    scan(type?: string, protocol?: string, domain?: string, implType?: ZeroconfImplType): void;
    stop(implType?: ZeroconfImplType): void;
    on(event: "resolved", cb: (service: ZeroconfService) => void): void;
    on(event: "error", cb: (err: Error) => void): void;
    on(event: "found" | "remove", cb: (name: string) => void): void;
    on(event: "start" | "stop" | "update", cb: () => void): void;
    removeAllListeners(): void;
  }
}
