import { packager } from '@electron/packager';
if (process.platform !== 'darwin') throw new Error('Run this packaging command on macOS.');
const paths = await packager({ dir: '.', out: 'dist', name: 'HostHarbor', platform: 'darwin', arch: process.arch, overwrite: true, prune: true, ignore: [/^\/(?:\.git|\.tools|tests|docs|scripts|dist)(?:\/|$)/, /^\/(?:AGENTS\.md|CV_EXPERIENCE_CHECKPOINT\.md|handsOff\.md)$/], appBundleId: 'app.hostharbor.desktop', appCategoryType: 'public.app-category.developer-tools', osxSign: false });
console.log(paths.join('\n'));
