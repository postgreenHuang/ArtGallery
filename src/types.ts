export interface Artwork {
  id: number;
  file: string;
  title: string;
  artist: string;
  date: string;
  description: string;
  thumb: string;
  original: string;
  source: string;
  width: number;
  height: number;
  license: string;
  licenseUrl: string;
  attribution: string;
}
export interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  artworks?: Artwork[];
  query?: string;
  scope?: Settings["scope"];
  offset?: number;
  error?: boolean;
  suggestions?: ArtistSuggestion[];
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
  theme: "light" | "dark" | "system";
}
export interface Library {
  version: 1;
  conversations: Conversation[];
  saved: SavedArtwork[];
  settings: Settings;
}
export const defaultLibrary: Library = {
  version: 1,
  conversations: [],
  saved: [],
  settings: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    useAi: false,
    scope: "google",
    theme: "light",
  },
};
