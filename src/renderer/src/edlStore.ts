import JSON5 from 'json5';
import i18n from 'i18next';
import invariant from 'tiny-invariant';
import { ZodError } from 'zod';

import { parseSrtToSegments, formatSrt, parseCuesheet, parseXmeml, parseFcpXml, parseCsv, parseCutlist, parsePbf, parseEdl, formatCsvHuman, formatTsv, formatCsvFrames, formatCsvSeconds, parseCsvTime, getFrameValParser, parseDvAnalyzerSummaryTxt, parseOtio } from './edlFormats';
import { askForYouTubeInput, showOpenDialog } from './dialogs';
import { getOutPath } from './util';
import { EdlExportType, EdlFileType, EdlImportType, GetFrameCount, LlcProject, llcProjectV1Schema, llcProjectV2Schema, SegmentBase, StateSegment } from './types';
import { mapSaveableSegments } from './segments';
import isDev from './isDev';

const { readFile, writeFile } = window.require('fs/promises');
const cueParser = window.require('cue-parser');
const { basename } = window.require('path');

const { dialog } = window.require('@electron/remote');


async function loadCsvSeconds(path: string) {
  return parseCsv(await readFile(path, 'utf8'), parseCsvTime);
}

async function loadCsvFrames(path: string, fps: number) {
  return parseCsv(await readFile(path, 'utf8'), getFrameValParser(fps));
}

async function loadCutlistSeconds(path: string) {
  return parseCutlist(await readFile(path, 'utf8'));
}

async function loadXmeml(path: string) {
  return parseXmeml(await readFile(path, 'utf8'));
}

async function loadFcpXml(path: string) {
  return parseFcpXml(await readFile(path, 'utf8'));
}

async function loadDvAnalyzerSummaryTxt(path: string) {
  return parseDvAnalyzerSummaryTxt(await readFile(path, 'utf8'));
}

async function loadPbf(path: string) {
  return parsePbf(await readFile(path));
}

async function loadEdl(path: string, fps: number) {
  return parseEdl(await readFile(path, 'utf8'), fps);
}

async function loadCue(path: string) {
  return parseCuesheet(cueParser.parse(path));
}

async function loadSrt(path: string) {
  return parseSrtToSegments(await readFile(path, 'utf8'));
}

export async function saveCsv(path: string, cutSegments: SegmentBase[]) {
  await writeFile(path, await formatCsvSeconds(cutSegments));
}

export async function saveCsvHuman(path: string, cutSegments: SegmentBase[]) {
  await writeFile(path, await formatCsvHuman(cutSegments));
}

export async function saveCsvFrames({ path, cutSegments, getFrameCount }: {
  path: string,
  cutSegments: SegmentBase[],
  getFrameCount: GetFrameCount,
}) {
  await writeFile(path, await formatCsvFrames({ cutSegments, getFrameCount }));
}

export async function saveTsv(path: string, cutSegments: SegmentBase[]) {
  await writeFile(path, await formatTsv(cutSegments));
}

export async function saveSrt(path: string, cutSegments: SegmentBase[]) {
  await writeFile(path, formatSrt(cutSegments));
}

export async function saveLlcProject({ savePath, filePath, cutSegments }: {
  savePath: string,
  filePath: string,
  cutSegments: StateSegment[],
}) {
  const projectData: LlcProject = {
    version: 2,
    mediaFileName: basename(filePath),
    cutSegments: mapSaveableSegments(cutSegments),
  };
  await writeFile(savePath, JSON5.stringify(projectData, null, 2));
}

export async function loadLlcProject(path: string) {
  const json = JSON5.parse(await readFile(path, 'utf8'));

  async function doLoad(): Promise<LlcProject> {
    // todo probably remove migration in future
    try {
      return llcProjectV2Schema.parse(json);
    } catch (err) {
      if (err instanceof ZodError) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { cutSegments, version: _ignored, ...restProject } = llcProjectV1Schema.parse(json);
        console.log('Converting v1 project to v2');
        return {
          ...restProject,
          version: 2,
          cutSegments: cutSegments.map(({ start, ...restSeg }) => ({
            ...restSeg,
            start: start ?? 0, // v1 allowed undefined for "start", which we no longer allow as of v2
          })),
        };
      }
      throw err;
    }
  }

  const project = await doLoad();
  console.log(`Loaded LLC project v${project.version}, mediaFileName: ${project.mediaFileName}, ${project.cutSegments.length} segments`);
  if (isDev) console.log(project);
  return project;
}

export async function loadOtio(path: string) {
  return parseOtio(JSON.parse(await readFile(path, 'utf8')));
}

export async function readEdlFile({ type, path, fps }: {
  type: EdlFileType,
  path: string,
  fps: number | undefined,
}) {
  if (type === 'csv') return loadCsvSeconds(path);
  if (type === 'csv-frames' || type === 'edl') {
    invariant(fps != null, 'The loaded media has an unknown framerate');
    if (type === 'csv-frames') return loadCsvFrames(path, fps);
    if (type === 'edl') return loadEdl(path, fps);
  }
  if (type === 'cutlist') return loadCutlistSeconds(path);
  if (type === 'xmeml') return loadXmeml(path);
  if (type === 'fcpxml') return loadFcpXml(path);
  if (type === 'dv-analyzer-summary-txt') return loadDvAnalyzerSummaryTxt(path);
  if (type === 'cue') return loadCue(path);
  if (type === 'pbf') return loadPbf(path);
  if (type === 'srt') return loadSrt(path);
  if (type === 'otio') return loadOtio(path);
  if (type === 'llc') {
    const project = await loadLlcProject(path);
    return project.cutSegments;
  }
  throw new Error('Invalid EDL type');
}

export async function askForEdlImport({ type, fps }: { type: EdlImportType, fps?: number | undefined }) {
  if (type === 'youtube') return askForYouTubeInput();

  let filters;
  // eslint-disable-next-line unicorn/prefer-switch
  if (type === 'csv' || type === 'csv-frames') filters = [{ name: i18n.t('CSV files'), extensions: ['csv'] }];
  else if (type === 'xmeml') filters = [{ name: i18n.t('XML files'), extensions: ['xml'] }];
  else if (type === 'fcpxml') filters = [{ name: i18n.t('FCPXML files'), extensions: ['fcpxml'] }];
  else if (type === 'cue') filters = [{ name: i18n.t('CUE files'), extensions: ['cue'] }];
  else if (type === 'pbf') filters = [{ name: i18n.t('PBF files'), extensions: ['pbf'] }];
  else if (type === 'edl') filters = [{ name: i18n.t('EDL'), extensions: ['*'] }];
  else if (type === 'dv-analyzer-summary-txt') filters = [{ name: i18n.t('DV Analyzer Summary.txt'), extensions: ['txt'] }];
  else if (type === 'srt') filters = [{ name: i18n.t('Subtitles (SRT)'), extensions: ['srt'] }];
  else if (type === 'llc') filters = [{ name: i18n.t('LosslessCut project'), extensions: ['llc'] }];

  const { canceled, filePaths } = await showOpenDialog({
    properties: ['openFile'],
    title: i18n.t('Import project'),
    ...(filters && { filters }),
  });
  const [firstFilePath] = filePaths;
  if (canceled || firstFilePath == null) return [];
  return readEdlFile({ type, path: firstFilePath, fps });
}

export async function exportEdlFile({ type, cutSegments, customOutDir, filePath, getFrameCount }: {
  type: EdlExportType,
  cutSegments: StateSegment[],
  customOutDir?: string | undefined,
  filePath?: string | undefined,
  getFrameCount: GetFrameCount,
}) {
  invariant(filePath != null);

  let filters: { name: string, extensions: string[] }[] | undefined;
  let ext: string | undefined;
  // eslint-disable-next-line unicorn/prefer-switch
  if (type === 'csv') {
    ext = 'csv';
    filters = [{ name: i18n.t('CSV files'), extensions: [ext, 'txt'] }];
  } else if (type === 'tsv-human') {
    ext = 'tsv';
    filters = [{ name: i18n.t('TXT files'), extensions: [ext, 'txt'] }];
  } else if (type === 'csv-human') {
    ext = 'csv';
    filters = [{ name: i18n.t('TXT files'), extensions: [ext, 'txt'] }];
  } else if (type === 'csv-frames') {
    ext = 'csv';
    filters = [{ name: i18n.t('TXT files'), extensions: [ext, 'txt'] }];
  } else if (type === 'srt') {
    ext = 'srt';
    filters = [{ name: i18n.t('Subtitles (SRT)'), extensions: [ext, 'txt'] }];
  } else if (type === 'llc') {
    ext = 'llc';
    filters = [{ name: i18n.t('LosslessCut project'), extensions: [ext, 'llc'] }];
  }

  const defaultPath = getOutPath({ filePath, customOutDir, fileName: `${basename(filePath)}.${ext}` });

  const { canceled, filePath: savePath } = await dialog.showSaveDialog({ defaultPath, title: i18n.t('Export project'), ...(filters != null ? { filters } : {}) });
  if (canceled || !savePath) return;
  console.log('Saving', type, savePath);
  // eslint-disable-next-line unicorn/prefer-switch
  if (type === 'csv') await saveCsv(savePath, cutSegments);
  else if (type === 'tsv-human') await saveTsv(savePath, cutSegments);
  else if (type === 'csv-human') await saveCsvHuman(savePath, cutSegments);
  else if (type === 'csv-frames') await saveCsvFrames({ path: savePath, cutSegments, getFrameCount });
  else if (type === 'llc') await saveLlcProject({ savePath, filePath, cutSegments });
  else if (type === 'srt') await saveSrt(savePath, cutSegments);
}
