export type Beat = { say?: string; do?: string; show?: string };
export type Adaptation = {
  id: string;
  libraryId?: string;
  sourceUrl?: string;
  brandId?: string | null;
  brandName?: string;
  title?: string;
  addedAt?: string;
  status?: string;
  retrying?: boolean;
  retryable?: boolean;
  noteKind?: string;
  note?: string;
  adaptation?: { hook?: string; beats?: Beat[]; cta?: string; caption?: string };
  format?: { name?: string };
  source?: {
    title?: string;
    script?: { text?: string; segments?: [number, number, string][] };
    shots?: { t?: number; visual?: string; onscreen_text?: string }[];
  };
  [key: string]: unknown;
};

export type LibraryItem = {
  id: string; url: string; canon: string; platform: string;
  title?: string; creator?: string; caption?: string; addedAt?: string;
};

export type CreatorData = {
  name?: string;
  adaptations?: Adaptation[];
  library?: LibraryItem[];
  [key: string]: unknown;
};

export type CreatorRow = { id: string; updated_at: string; data: CreatorData };

export type Database = {
  public: {
    Tables: {
      lynxr_creators: {
        Row: CreatorRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: Record<never, never>;
  };
};

export function entries(data?: CreatorData): Adaptation[] {
  return Array.isArray(data?.adaptations)
    ? data.adaptations.filter((job) => job && typeof job.id === 'string')
    : [];
}

export function hasWork(job: Adaptation): boolean {
  return job.status === 'queued' || job.status === 'running' ||
    (job.status === 'error' && job.retrying === true);
}

export function statusLabel(job: Adaptation): string {
  switch (job.status) {
    case 'queued': return 'Queued';
    case 'running': return 'Processing';
    case 'done': return 'Completed';
    case 'error': return job.retrying ? 'Retry scheduled' : 'Failed';
    default: return 'Status unavailable';
  }
}

export function scriptTitle(job: Adaptation, data?: CreatorData) {
  const item = Array.isArray(data?.library) ? data.library.find((item) => item?.id === job.libraryId) : undefined;
  return job.title || item?.title || job.source?.title || (job.brandId ? 'Brand script' : 'Original script');
}

export function scriptSections(job: Adaptation): { title: string; lines: string[] }[] {
  if (job.status !== 'done') return [];
  if (job.brandId || (job.adaptation && !job.source)) {
    if (!job.adaptation) return [];
    const { hook, beats, cta, caption } = job.adaptation;
    return [
      { title: 'Hook', lines: hook ? [hook] : [] },
      ...(Array.isArray(beats) ? beats.filter(Boolean).map((beat, index) => ({
        title: `Beat ${index + 1}`,
        lines: [beat.say, beat.do && `Do: ${beat.do}`, beat.show && `On screen: ${beat.show}`].filter(Boolean) as string[],
      })) : []),
      { title: 'Call to action', lines: cta ? [cta] : [] },
      { title: 'Caption', lines: caption ? [caption] : [] },
    ].filter(({ lines }) => lines.length);
  }
  const source = job.source;
  const segments = source?.script?.segments;
  const spoken = Array.isArray(segments) ? segments.map((segment) => segment?.[2]).filter(Boolean) : [];
  const shots = Array.isArray(source?.shots) ? source.shots.filter(Boolean) : [];
  return [
    { title: 'What they say', lines: spoken.length ? spoken : source?.script?.text ? [source.script.text] : [] },
    { title: 'What’s on screen', lines: shots.flatMap((s) => [s.visual, s.onscreen_text && `Text: ${s.onscreen_text}`].filter(Boolean) as string[]) },
  ].filter(({ lines }) => lines.length);
}
