export interface Artwork {
  id: number;
  provider?: "cleveland" | "chicago" | "met";
  file: string;
  title: string;
  artist: string;
  date: string;
  description: string;
  thumb: string;
  original: string;
  medium?: string;
  hd?: string;
  source: string;
  width: number;
  height: number;
  license: string;
  licenseUrl: string;
  attribution: string;
  selectionReason?: string;
  curatorReason?: string;
  pageEvidence?: PageEvidence;
  review?: CandidateReview;
}
export interface SearchCriteria {
  required: string[];
  preferred: string[];
  excluded: string[];
  requiresImage: boolean;
}
export interface PageEvidence {
  url: string;
  title: string;
  text: string;
  status: "read" | "unavailable";
  error?: string;
}
export interface CandidateReview {
  verdict: "keep" | "reject" | "uncertain";
  reason: string;
  confidence: number;
  basis: "metadata" | "page" | "image" | "unavailable";
  quote?: string;
  imageProvided: boolean;
  pageRead: boolean;
}
export interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  artworks?: Artwork[];
  query?: string;
  scope?: Settings["scope"];
  offset?: number;
  providerOffsets?: Partial<Record<"commons" | "cleveland" | "chicago" | "met", number>>;
  targetArtist?: string;
  artistAliases?: string[];
  webResults?: WebResult[];
  searchWarning?: string;
  error?: boolean;
  suggestions?: ArtistSuggestion[];
  searchCriteria?: SearchCriteria;
  originalRequest?: string;
  reviewCompleted?: boolean;
  reviewPending?: boolean;
  searchQueries?: string[];
  rejectedArtworks?: Artwork[];
  rejectedWebResults?: WebResult[];
}
export interface WebResult {
  title: string;
  url: string;
  thumbnail?: string;
  description: string;
  source: string;
  selectionReason?: string;
  pageEvidence?: PageEvidence;
  review?: CandidateReview;
}
export interface ArtistSuggestion {
  nameZh: string;
  nameEn: string;
  query: string;
  reason: string;
  scope?: Settings["scope"];
}
export interface Conversation {
  id: string;
  title: string;
  updated: number;
  messages: Message[];
  kind?: "inspiration" | "artwork";
  artwork?: Artwork;
}
export interface SavedArtwork {
  artwork: Artwork;
  savedAt: number;
  local: string;
}
export interface Settings {
  baseUrl: string;
  model: string;
  useAi: boolean;
  scope: "google" | "commons";
  theme: "light" | "contrast" | "warm" | "dark" | "system";
  explanationFontSize: number;
  webSearch?: boolean;
}
export interface Library {
  version: 1;
  conversations: Conversation[];
  saved: SavedArtwork[];
  viewed: Artwork[];
  settings: Settings;
}
export const defaultLibrary: Library = {
  version: 1,
  conversations: [],
  saved: [],
  viewed: [],
  settings: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    useAi: false,
    scope: "google",
    theme: "light",
    explanationFontSize: 16,
  },
};
