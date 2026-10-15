export declare const OPEN_PORTAL: "open_portal";

export interface OpenPortalSpec {
  readonly name: "open_portal";
  readonly description: string;
  readonly slugDescription: string;
}

export declare const OPEN_PORTAL_SPEC: OpenPortalSpec;

export declare const PORTALS: Readonly<Record<string, string>>;

export declare function resolvePortal(slug: unknown): string | null;
