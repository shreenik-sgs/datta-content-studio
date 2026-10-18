#!/usr/bin/env python3
"""Offline review transcription; optional mlx-whisper runtime on Apple Silicon.

Install mlx-whisper==0.4.3 in an isolated environment. Model weights are downloaded
on first use; source audio is never sent to the model host. This does not adopt a
production ASR provider or approve the resulting transcript.
"""
import argparse
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path


def digest(path):
    checksum = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(chunk)
    return checksum.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--language', required=True, choices=('te', 'kn', 'ta'))
    parser.add_argument('--model', default='mlx-community/whisper-large-v3-mlx')
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    if args.output.exists():
        parser.error('Output already exists; choose a new immutable transcript version.')
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    import mlx_whisper
    source_sha = digest(source)
    with tempfile.TemporaryDirectory(prefix='sgs-local-recognition-') as temporary:
        audio = Path(temporary) / 'source.wav'
        subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
                        '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov',
                        '-enable_drefs', '0', '-use_absolute_path', '0', '-f', 'mov',
                        '-i', str(source), '-vn', '-ar', '16000', '-ac', '1', str(audio)],
                       check=True, timeout=120)
        result = mlx_whisper.transcribe(str(audio), path_or_hf_repo=args.model,
                                        language=args.language, task='transcribe',
                                        word_timestamps=True, condition_on_previous_text=False,
                                        verbose=True)
        if digest(source) != source_sha:
            raise RuntimeError('Source changed during transcription.')
        result['sourceSha256'] = source_sha
        result['localProvenance'] = {'model': args.model, 'runtime': 'mlx-whisper',
                                     'audioSha256': digest(audio), 'review': None,
                                     'world': 'TEST', 'publishAllowed': False}
        with args.output.open('x', encoding='utf8') as destination:
            json.dump(result, destination, ensure_ascii=False, indent=2)
        args.output.chmod(0o600)


if __name__ == '__main__':
    main()
