import { LensService } from '@riffcc/lens-sdk';
import { logger, logError } from '../logger.js';
import { input, select } from '@inquirer/prompts';
// @ts-ignore
import jsmediatags from 'jsmediatags';

interface TrackMetadata {
  title: string;
  artist?: string;
  duration?: string;
}

interface TrackUpdate {
  releaseId: string;
  releaseName: string;
  trackIndex: number;
  currentTitle: string;
  id3Title: string;
  action: 'update' | 'skip';
}

export async function handleUpdateTrackNamesFromID3(lensService: LensService) {
  try {
    logger.info('Fetching music releases...');
    
    // Get all releases
    const releases = await lensService.getReleases();
    if (!releases || releases.length === 0) {
      logger.info('No releases found');
      return;
    }
    
    // Get content categories to identify music
    const categories = await lensService.getContentCategories();
    const musicCategory = categories.find(c => c.categoryId === 'music');
    
    if (!musicCategory) {
      logger.error('Music category not found');
      return;
    }
    
    // Filter music releases
    const musicReleases = releases.filter(r => r.categoryId === musicCategory.id);
    
    if (musicReleases.length === 0) {
      logger.info('No music releases found');
      return;
    }
    
    logger.info(`Found ${musicReleases.length} music releases`);
    
    // Process each release
    const updates: TrackUpdate[] = [];
    const newTracks: { releaseId: string; releaseName: string; tracks: TrackMetadata[] }[] = [];
    
    for (const release of musicReleases) {
      logger.info(`\nProcessing: ${release.name}`);
      
      // Parse existing metadata
      let metadata: any = {};
      if (release.metadata) {
        try {
          metadata = typeof release.metadata === 'string' 
            ? JSON.parse(release.metadata) 
            : release.metadata;
        } catch (e) {
          logger.warn(`Failed to parse metadata for release ${release.name}`);
        }
      }
      
      // Get existing track metadata
      let existingTracks: TrackMetadata[] = [];
      if (metadata.trackMetadata) {
        try {
          existingTracks = typeof metadata.trackMetadata === 'string'
            ? JSON.parse(metadata.trackMetadata)
            : metadata.trackMetadata;
        } catch (e) {
          logger.warn(`Failed to parse track metadata for release ${release.name}`);
        }
      }
      
      // Fetch track listing from IPFS
      const tracks = await fetchIPFSTracks(release.contentCID);
      
      if (tracks.length === 0) {
        logger.warn(`No tracks found for release ${release.name}`);
        continue;
      }
      
      // Check each track
      const releaseNewTracks: TrackMetadata[] = [];
      
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        const existingTrack = existingTracks[i];
        
        try {
          // Read ID3 tags
          const id3Data = await readID3Tags(track.url);
          
          if (!id3Data.title) {
            logger.warn(`No ID3 title found for track ${i + 1}: ${track.filename}`);
            continue;
          }
          
          if (!existingTrack?.title) {
            // No stored title - this is a new track
            releaseNewTracks.push({
              title: id3Data.title,
              artist: id3Data.artist,
              duration: existingTrack?.duration
            });
            logger.info(`  New track ${i + 1}: "${id3Data.title}"`);
          } else if (existingTrack.title !== id3Data.title) {
            // Title mismatch
            updates.push({
              releaseId: release.id,
              releaseName: release.name,
              trackIndex: i,
              currentTitle: existingTrack.title,
              id3Title: id3Data.title,
              action: 'skip' // Default to skip, will ask user
            });
            logger.warn(`  Track ${i + 1} mismatch: "${existingTrack.title}" vs ID3: "${id3Data.title}"`);
          }
        } catch (error) {
          logger.warn(`Failed to read ID3 tags for track ${i + 1}: ${error}`);
        }
      }
      
      if (releaseNewTracks.length > 0) {
        newTracks.push({
          releaseId: release.id,
          releaseName: release.name,
          tracks: releaseNewTracks
        });
      }
    }
    
    // Show summary
    logger.info('\n=== Summary ===');
    logger.info(`New tracks to import: ${newTracks.reduce((sum, r) => sum + r.tracks.length, 0)}`);
    logger.info(`Mismatched tracks: ${updates.length}`);
    
    if (newTracks.length === 0 && updates.length === 0) {
      logger.info('All track names are up to date!');
      return;
    }
    
    // Handle new tracks
    if (newTracks.length > 0) {
      const importNew = await input({
        message: 'Import track names for releases without stored metadata? (yes/no)',
        default: 'yes',
      });
      
      if (importNew.toLowerCase() === 'yes' || importNew.toLowerCase() === 'y') {
        for (const releaseUpdate of newTracks) {
          await updateReleaseTrackMetadata(lensService, releaseUpdate.releaseId, releaseUpdate.tracks);
          logger.info(`✅ Updated ${releaseUpdate.releaseName} with ${releaseUpdate.tracks.length} track names`);
        }
      }
    }
    
    // Handle mismatches
    if (updates.length > 0) {
      logger.info('\n=== Track Name Mismatches ===');
      
      const action = await select({
        message: 'How would you like to handle mismatches?',
        choices: [
          { name: 'Review each mismatch individually', value: 'individual' },
          { name: 'Update all to match ID3 tags', value: 'all' },
          { name: 'Skip all mismatches', value: 'skip' },
        ],
      });
      
      if (action === 'all') {
        updates.forEach(u => u.action = 'update');
      } else if (action === 'individual') {
        for (const update of updates) {
          const choice = await select({
            message: `${update.releaseName} - Track ${update.trackIndex + 1}:\n  Current: "${update.currentTitle}"\n  ID3 tag: "${update.id3Title}"\n  Action:`,
            choices: [
              { name: 'Update to ID3 tag', value: 'update' },
              { name: 'Keep current', value: 'skip' },
            ],
          });
          update.action = choice as 'update' | 'skip';
        }
      }
      
      // Apply updates
      const updatesToApply = updates.filter(u => u.action === 'update');
      if (updatesToApply.length > 0) {
        // Group by release
        const updatesByRelease = new Map<string, TrackUpdate[]>();
        updatesToApply.forEach(u => {
          if (!updatesByRelease.has(u.releaseId)) {
            updatesByRelease.set(u.releaseId, []);
          }
          updatesByRelease.get(u.releaseId)!.push(u);
        });
        
        // Apply updates for each release
        for (const [releaseId, releaseUpdates] of updatesByRelease) {
          const release = musicReleases.find(r => r.id === releaseId)!;
          
          // Get current track metadata
          let metadata: any = {};
          if (release.metadata) {
            try {
              metadata = typeof release.metadata === 'string' 
                ? JSON.parse(release.metadata) 
                : release.metadata;
            } catch (e) {}
          }
          
          let tracks: TrackMetadata[] = [];
          if (metadata.trackMetadata) {
            try {
              tracks = typeof metadata.trackMetadata === 'string'
                ? JSON.parse(metadata.trackMetadata)
                : metadata.trackMetadata;
            } catch (e) {}
          }
          
          // Apply updates
          releaseUpdates.forEach(update => {
            if (tracks[update.trackIndex]) {
              tracks[update.trackIndex].title = update.id3Title;
            }
          });
          
          // Save
          await updateReleaseTrackMetadata(lensService, releaseId, tracks);
          logger.info(`✅ Updated ${release.name} with ${releaseUpdates.length} track name changes`);
        }
      }
    }
    
    logger.info('\nTrack name update complete!');
    
  } catch (error) {
    logError('Error updating track names from ID3 tags', error);
  }
}

async function fetchIPFSTracks(contentCID: string): Promise<{ filename: string; url: string; cid: string }[]> {
  const tracks: { filename: string; url: string; cid: string }[] = [];
  const ipfsGateway = process.env.IPFS_GATEWAY || 'http://localhost:8080';
  
  // Support both full URLs and host:port format
  const url = ipfsGateway.startsWith('http://') || ipfsGateway.startsWith('https://') 
    ? `${ipfsGateway}/ipfs/${contentCID}`
    : `http://${ipfsGateway}/ipfs/${contentCID}`;
  
  logger.info(`Fetching tracks from IPFS: ${url}`);
  
  try {
    // Check if it's a directory or single file
    const headResponse = await globalThis.fetch(url, { method: 'HEAD' });
    if (!headResponse.ok) {
      logger.error(`IPFS fetch failed: ${headResponse.status} ${headResponse.statusText} for ${url}`);
      throw new Error(`Failed to fetch from IPFS: ${headResponse.status}`);
    }
    
    const contentType = headResponse.headers.get('content-type');
    
    // Single audio file
    if (contentType && (contentType.includes('audio/') || contentType.includes('application/octet-stream'))) {
      tracks.push({
        filename: 'single-track',
        url: url,
        cid: contentCID
      });
      return tracks;
    }
    
    // Directory listing
    const response = await globalThis.fetch(url);
    const responseText = await response.text();
    
    // Parse HTML directory listing
    const { parse } = await import('node-html-parser');
    const root = parse(responseText);
    
    // Find all links to audio files
    const links = root.querySelectorAll('a');
    links.forEach((link: any) => {
      const href = link.getAttribute('href');
      if (href && href.includes('/ipfs/')) {
        const filename = link.innerText;
        if (filename && ['mp3', 'flac', 'ogg', 'm4a', 'wav'].some(ext => filename.toLowerCase().endsWith('.' + ext))) {
          const cidMatch = href.match(/\/ipfs\/([^?]+)/);
          if (cidMatch) {
            const trackUrl = ipfsGateway.startsWith('http://') || ipfsGateway.startsWith('https://') 
              ? `${ipfsGateway}/ipfs/${cidMatch[1]}`
              : `http://${ipfsGateway}/ipfs/${cidMatch[1]}`;
            tracks.push({
              filename: filename,
              url: trackUrl,
              cid: cidMatch[1]
            });
          }
        }
      }
    });
    
    // Sort tracks by filename to maintain order
    tracks.sort((a, b) => a.filename.localeCompare(b.filename));
    
  } catch (error) {
    logger.error(`Error fetching IPFS tracks for CID ${contentCID}:`, error);
  }
  
  logger.info(`Found ${tracks.length} tracks for CID ${contentCID}`);
  return tracks;
}

async function readID3Tags(url: string): Promise<{ title?: string; artist?: string }> {
  return new Promise((resolve) => {
    jsmediatags.read(url, {
      onSuccess: (tag: any) => {
        resolve({
          title: tag.tags.title,
          artist: tag.tags.artist
        });
      },
      onError: () => {
        resolve({});
      }
    });
  });
}

async function updateReleaseTrackMetadata(
  lensService: LensService, 
  releaseId: string, 
  tracks: TrackMetadata[]
): Promise<void> {
  const release = await lensService.getRelease(releaseId);
  if (!release) {
    throw new Error(`Release ${releaseId} not found`);
  }
  
  let metadata: any = {};
  if (release.metadata) {
    try {
      metadata = typeof release.metadata === 'string' 
        ? JSON.parse(release.metadata) 
        : release.metadata;
    } catch (e) {}
  }
  
  metadata.trackMetadata = JSON.stringify(tracks);
  
  await lensService.editRelease({
    id: release.id,
    postedBy: release.postedBy,
    siteAddress: release.siteAddress,
    name: release.name,
    categoryId: release.categoryId,
    contentCID: release.contentCID,
    thumbnailCID: release.thumbnailCID,
    metadata: JSON.stringify(metadata)
  });
}