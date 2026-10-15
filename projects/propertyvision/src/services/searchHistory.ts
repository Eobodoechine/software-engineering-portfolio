import type { SearchHistoryEntry, SearchHistoryFilters, PropertyAnalysisResponse } from '../types/property';

const COLLECTION_NAME = 'property-searches';

// Mock in-memory storage (replace with Redis or database later)
const mockSearchHistory: Map<string, SearchHistoryEntry> = new Map();

export class SearchHistoryService {
  static async createSearch(userId: string, address: string): Promise<string> {
    const searchId = `search-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const searchData: SearchHistoryEntry = {
      id: searchId,
      userId,
      address,
      status: 'pending' as const,
      createdAt: new Date()
    };

    mockSearchHistory.set(searchId, searchData);
    return searchId;
  }

  static async updateSearchStatus(
    searchId: string,
    status: 'completed' | 'failed',
    result?: PropertyAnalysisResponse,
    error?: string
  ): Promise<void> {
    const existingSearch = mockSearchHistory.get(searchId);
    if (!existingSearch) {
      throw new Error(`Search ${searchId} not found`);
    }

    const updatedSearch: SearchHistoryEntry = {
      ...existingSearch,
      status,
      completedAt: new Date(),
      result,
      error
    };

    mockSearchHistory.set(searchId, updatedSearch);
  }

  static async getUserSearchHistory(
    userId: string,
    filters?: SearchHistoryFilters
  ): Promise<SearchHistoryEntry[]> {
    let searches = Array.from(mockSearchHistory.values())
      .filter(search => search.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    if (filters?.status && filters.status !== 'all') {
      searches = searches.filter(search => search.status === filters.status);
    }

    if (filters?.limit) {
      searches = searches.slice(0, filters.limit);
    }

    return searches;
  }

  static async getSearchById(searchId: string): Promise<SearchHistoryEntry | null> {
    return mockSearchHistory.get(searchId) || null;
  }
}
