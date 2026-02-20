import { ViralResult } from '@gitroom/frontend/components/materials/viral-score';

export interface MaterialItem {
  id: string;
  platform: string;
  externalId: string;
  title?: string;
  desc?: string;
  coverUrl?: string;
  contentUrl?: string;
  authorName?: string;
  authorAvatar?: string;
  authorUserId?: string;
  createdAt: string;
  likedCount?: number;
  collectedCount?: number;
  commentCount?: number;
  shareCount?: number;
  followerCount?: number;
  viralResult?: ViralResult;
}
