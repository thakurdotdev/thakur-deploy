'use client';

import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react';

interface LogSearchProps {
  searchTerm: string;
  setSearchTerm: (term: string) => void;
  matchCount: number;
  currentMatchIndex: number;
  onPrevMatch: () => void;
  onNextMatch: () => void;
  onClose: () => void;
}

export function LogSearch({
  searchTerm,
  setSearchTerm,
  matchCount,
  currentMatchIndex,
  onPrevMatch,
  onNextMatch,
  onClose,
}: LogSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex items-center gap-1 bg-zinc-800 rounded px-2 py-1">
      <Search className="w-3 h-3 text-zinc-500 shrink-0" />
      <Input
        ref={inputRef}
        type="text"
        placeholder="Find..."
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        className="h-5 w-20 sm:w-28 text-xs bg-transparent border-none focus-visible:ring-0 px-1"
        autoFocus
      />
      {matchCount > 0 && (
        <span className="text-xs text-zinc-500 tabular-nums shrink-0">
          {currentMatchIndex + 1}/{matchCount}
        </span>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-5 w-5 text-zinc-500 hover:text-zinc-300"
        onClick={onPrevMatch}
        disabled={matchCount === 0}
      >
        <ChevronUp className="w-3 h-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-5 w-5 text-zinc-500 hover:text-zinc-300"
        onClick={onNextMatch}
        disabled={matchCount === 0}
      >
        <ChevronDown className="w-3 h-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-5 w-5 text-zinc-500 hover:text-zinc-300"
        onClick={onClose}
      >
        <X className="w-3 h-3" />
      </Button>
    </div>
  );
}
