// Min-Heap for Top-K Selection
// Efficiently maintains K best items without storing entire array

import { jobLog } from './jobLogger';

export class MinHeap<T> {
  private heap: Array<{ item: T; score: number }> = [];
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  /**
   * Add an item with its score
   * If heap is full and score is better than worst, replace worst
   */
  add(item: T, score: number): void {
    try {
      if (this.heap.length < this.maxSize) {
        // Heap not full, add directly
        this.heap.push({ item, score });
        this.bubbleUp(this.heap.length - 1);
      } else if (score < this.heap[0].score) {
        // Score is better (smaller) than worst item, replace root
        this.heap[0] = { item, score };
        this.bubbleDown(0);
      }
      // Otherwise, item is worse than all current items, ignore it
    } catch (error) {
      console.error(`❌ MIN HEAP ADD ERROR:`);
      console.error(`   Error type: ${typeof error}`);
      console.error(`   Error message: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`   Error stack:`, error instanceof Error ? error.stack : 'N/A');
      console.error(`   Score: ${score}, Heap size: ${this.heap.length}, Max: ${this.maxSize}`);
      console.error(`   Item:`, item);
    }
  }

  /**
   * Get all items sorted by score (best first)
   */
  getSorted(): T[] {
    try {
      // Sort by score ascending (smaller scores = better)
      return [...this.heap]
        .sort((a, b) => a.score - b.score)
        .map(node => node.item);
    } catch (error) {
      console.error(`❌ MIN HEAP GET_SORTED ERROR:`);
      console.error(`   Error type: ${typeof error}`);
      console.error(`   Error message: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`   Error stack:`, error instanceof Error ? error.stack : 'N/A');
      console.error(`   Heap size: ${this.heap.length}`);
      return []; // Return empty array on error
    }
  }

  /**
   * Get current size
   */
  size(): number {
    return this.heap.length;
  }

  /**
   * Check if heap is full
   */
  isFull(): boolean {
    return this.heap.length >= this.maxSize;
  }

  /**
   * Get worst (highest score) item without removing
   */
  peekWorst(): { item: T; score: number } | null {
    return this.heap.length > 0 ? this.heap[0] : null;
  }

  /**
   * Bubble up element at index to maintain heap property
   */
  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.heap[index].score >= this.heap[parentIndex].score) {
        break;
      }
      this.swap(index, parentIndex);
      index = parentIndex;
    }
  }

  /**
   * Bubble down element at index to maintain heap property
   */
  private bubbleDown(index: number): void {
    while (true) {
      let smallest = index;
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;

      if (leftChild < this.heap.length && this.heap[leftChild].score < this.heap[smallest].score) {
        smallest = leftChild;
      }

      if (rightChild < this.heap.length && this.heap[rightChild].score < this.heap[smallest].score) {
        smallest = rightChild;
      }

      if (smallest === index) {
        break;
      }

      this.swap(index, smallest);
      index = smallest;
    }
  }

  /**
   * Swap two elements in heap
   */
  private swap(i: number, j: number): void {
    [this.heap[i], this.heap[j]] = [this.heap[j], this.heap[i]];
  }
}

/**
 * Helper function to get top K items from iterator
 */
export function topK<T>(
  items: Iterable<T>,
  k: number,
  scoreFn: (item: T) => number
): T[] {
  try {
    const heap = new MinHeap<T>(k);
    let processedCount = 0;

    for (const item of items) {
      try {
        const score = scoreFn(item);
        if (typeof score !== 'number' || isNaN(score)) {
          console.error(`❌ TOP K SCORE ERROR: scoreFn returned invalid score: ${score}`);
          console.error(`   Item:`, item);
          continue; // Skip invalid scores
        }
        heap.add(item, score);
        processedCount++;
      } catch (error) {
        console.error(`❌ TOP K SCORE FUNCTION ERROR:`);
        console.error(`   Error type: ${typeof error}`);
        console.error(`   Error message: ${error instanceof Error ? error.message : String(error)}`);
        console.error(`   Error stack:`, error instanceof Error ? error.stack : 'N/A');
        console.error(`   Item:`, item);
        // Continue processing other items
      }
    }

    jobLog(`📊 TOP K: Processed ${processedCount} items, returning top ${Math.min(k, processedCount)}`);
    return heap.getSorted();
  } catch (error) {
    console.error(`❌ TOP K ERROR:`);
    console.error(`   Error type: ${typeof error}`);
    console.error(`   Error message: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`   Error stack:`, error instanceof Error ? error.stack : 'N/A');
    console.error(`   K: ${k}`);
    return []; // Return empty array on fatal error
  }
}
