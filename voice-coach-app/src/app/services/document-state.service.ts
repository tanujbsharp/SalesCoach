import { Inject, Injectable, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

export interface DocumentMetadata {
  id: string;
  filename: string;
  wordCount: number;
  charCount: number;
}

@Injectable({ providedIn: 'root' })
export class DocumentStateService {
  private readonly STORAGE_KEY = 'activeDocument';
  private metadata?: DocumentMetadata;

  constructor(@Inject(PLATFORM_ID) private platformId: Object) {
    if (this.isBrowser()) {
      const stored = localStorage.getItem(this.STORAGE_KEY);
      if (stored) {
        try {
          this.metadata = JSON.parse(stored) as DocumentMetadata;
        } catch {
          this.metadata = undefined;
        }
      }
    }
  }

  setDocument(meta: DocumentMetadata) {
    this.metadata = meta;
    if (this.isBrowser()) {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(meta));
    }
  }

  clearDocument() {
    this.metadata = undefined;
    if (this.isBrowser()) {
      localStorage.removeItem(this.STORAGE_KEY);
    }
  }

  getDocumentId(): string | undefined {
    return this.metadata?.id;
  }

  getMetadata(): DocumentMetadata | undefined {
    return this.metadata;
  }

  private isBrowser() {
    return isPlatformBrowser(this.platformId);
  }
}

