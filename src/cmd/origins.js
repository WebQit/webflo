
/**
 * imports
 */
import Fs from 'fs';
import Path from 'path';
import { spawn } from 'child_process';
import _any from '@webqit/util/arr/any.js';
import _beforeLast from '@webqit/util/str/beforeLast.js';
import _isObject from '@webqit/util/js/isObject.js';
import SimpleGit from 'simple-git';
import Webhooks from '@octokit/webhooks';
import * as origins from '../config/origins.js'

/**
 * @description
 */
export const desc = {
    deploy: 'Deploys a remote origin into the local directory.',
};

/**
 * @deploy
 */
export async function deploy(Ui, origin, flags = {}, layout = {}) {
    if (!_isObject(origin)) {
        if (!origin) {
            throw new Error(`Please provide a repository name.`);
        }
        if (origin.includes('/')) {
            if (!origin.startsWith('https://') || !origin.endsWith('.git')) {
                throw new Error(`Cannot deploy ${origin}: A valid https git repository is expected.`);
            }
            var urlSplit = _beforeLast(origin, '.git').split('/');
            var [ repo, branch ] = urlSplit.splice(-2).join('/').split(':');
            origin = {
                repo,
                branch: branch || 'master',
                host: urlSplit.pop(),
                url: origin,
                tag: repo.replace('/', '-'),
            };
        } else {
            const matches = await origins.match(origin, flags, layout);
            if (matches.length > 1) {
                throw new Error(`Cannot deploy ${origin}: Multiple deploy settings found.`);
            }
            if (!matches.length) {
                throw new Error(`Cannot deploy ${origin}: No deploy settings found.`);
            }
            origin = matches[0];
        }
    }
    // ---------------
    const isDeployPathSet = origin.deploy_path;
    origin.deploy_path = Path.join(layout.ROOT, origin.deploy_path || '.');
    // ---------------
    // Instance
    const git = SimpleGit();
    // Before calling git.init()
    var isNewDeployPath = !Fs.existsSync((origin.deploy_path || '') + '/.git');
    if (isDeployPathSet) {
        if (!Fs.existsSync(origin.deploy_path)) {
            Fs.mkdirSync(origin.deploy_path, {recursive: true});
        }
    }
    git.cwd(origin.deploy_path);
    // Must come after git.cwd()
    git.init();

    const hosts = {
        github: 'https://github.com',
        bitbucket: 'https://bitbucket.org',
    };
    const url = origin.url || hosts[origin.host] + '/' + origin.repo + '.git';

    // Deployment
    const pull = async () => {
        Ui.log('');
        const waiting = Ui.waiting(Ui.f`Deploying ${origin.tag}`);
        waiting.start();
        await git.reset('hard');
        return git.pull(origin.tag, origin.branch)
            .then(() => {
                waiting.stop();
                Ui.success(Ui.f`[${Ui.style.comment((new Date).toUTCString())}] Successfully deployed ${origin.tag + '@' + origin.branch} - ${url} to ${origin.deploy_path}!`);
                if (origin.ondeploy) {
                    Ui.success(Ui.f`[ondeploy] ${origin.ondeploy}`);
                    const run = cmd => new Promise((resolve, reject) => {
                        cmd = cmd.split(' ').map(a => a.trim()).filter(a => a);
                        const child = spawn(cmd.shift(), cmd, {
                            cwd: origin.deploy_path,
                            stdio: 'pipe',
                        });

                        /** See stdio: "pipe" above
                        child.stdout.on('data', data => {
                            Ui.log('[' + Ui.style.keyword('ONDEPLOY') + '][' + Ui.style.var('OUT') + ']:', data + '');
                        });

                        child.stderr.on('data', data => {
                            Ui.log('[' + Ui.style.keyword('ONDEPLOY') + '][' + Ui.style.err('ERR') + ']:', (data + '').trim());
                        });
                        */
                        
                        child.on('error', data => {
                            Ui.error(data);
                            reject(data);
                        });

                        child.on('exit', async exitCode => {
                            resolve(exitCode);
                        });
                    });
                    return origin.ondeploy.split('&&').map(cmd => cmd.trim()).reduce(
                        async (prev, cmd) => (await prev) === 0 ? run(cmd) : prev
                    , 0).then(exitCode => {
                        if (exitCode === 0 && origin.ondeploy_autoexit) {
                            Ui.success(Ui.f`[ondeploy_autoexit] Exiting...`);
                            process.exit();
                        }
                        return exitCode;
                    });
                }
            }).catch(err => {
                waiting.stop();
                Ui.error(err);
            });
    };

    // Remote layout
    return git.getRemotes().then(remotes => {
        if (!_any(remotes, remote => remote.name === origin.tag)
        // But if the folder was deleted and created anew,
        // the above would still hold true, so we detect that here
        || isNewDeployPath) {
            return git.addRemote(origin.tag, url)
                .then(() => {
                    Ui.log('');
                    Ui.info(Ui.f`Added new origin - ${origin.tag}: ${url}`);
                    return pull();
                })
                .catch(err => Ui.error(err));
        } else {
            return pull();
        }
    });
};

/**
 * @hook
 */
export function hook(Ui, event, flags = {}, layout = {}) {
    return new Promise(async (resolve, reject) => {
        const eventHandler = Webhooks.createEventHandler();
        eventHandler.on('push', async ({ name, payload }) => {
            const matches = (await origins.match(payload.repository.full_name, flags, layout)).filter(o => o.autodeploy);
            var deployParams;
            if (!(deployParams = matches[0])) {
                return;
            }
            if (matches.length > 1) {
                reject(`Failed deploy attempt (${payload.repository.full_name}): Multiple deploy settings found.`);
            }
            if (!deployParams.autodeploy_secret) {
                reject(`Failed deploy attempt (${payload.repository.full_name}): The deploy settings do not contain a secret.`);
            }
            if (!Webhooks.verify(deployParams.autodeploy_secret, payload, event.request.headers['x-hub-signature'])) {
                reject(`Failed deploy attempt (${payload.repository.full_name}): Signature mismatch.`);
            }
            if (payload.repository.disabled || payload.repository.archived) {
                reject(`Failed deploy attempt (${payload.repository.full_name}): Repository disabled or archived.`);
            }
            resolve(async (deployMsg = '') => {
                Ui.log('---------------------------');
                Ui.log(deployMsg);
                await deploy(Ui, deployParams, flags, layout);
                Ui.log('');
                Ui.log('---------------------------');
            });
        });
        if (event.request.headers['user-agent'] && event.request.headers['user-agent'].startsWith('GitHub-Hookshot/')) {
            var submits = await event.request.parse();
            eventHandler.receive({
                id: event.request.headers['x-github-delivery'],
                name: event.request.headers['x-github-event'],
                payload: submits.payload /* JSON object */,
            }).catch(reject);
        } else {
            resolve();
        }
    });
};