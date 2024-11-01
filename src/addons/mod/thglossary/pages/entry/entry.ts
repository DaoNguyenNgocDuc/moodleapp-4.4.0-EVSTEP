// (C) Copyright 2015 Moodle Pty Ltd.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { AddonModThGlossaryHelper } from '@addons/mod/thglossary/services/thglossary-helper';
import { AddonModThGlossaryOffline, AddonModThGlossaryOfflineEntry } from '@addons/mod/thglossary/services/thglossary-offline';
import { Component, OnDestroy, OnInit, Optional, ViewChild } from '@angular/core';
import { ActivatedRoute, ActivatedRouteSnapshot } from '@angular/router';
import { CoreRoutedItemsManagerSourcesTracker } from '@classes/items-management/routed-items-manager-sources-tracker';
import { CoreSwipeNavigationItemsManager } from '@classes/items-management/swipe-navigation-items-manager';
import { CoreSplitViewComponent } from '@components/split-view/split-view';
import { CoreCommentsCommentsComponent } from '@features/comments/components/comments/comments';
import { CoreComments } from '@features/comments/services/comments';
import { CoreRatingInfo } from '@features/rating/services/rating';
import { CoreTag } from '@features/tag/services/tag';
import { FileEntry } from '@awesome-cordova-plugins/file/ngx';
import { CoreNavigator } from '@services/navigator';
import { CoreNetwork } from '@services/network';
import { CoreDomUtils, ToastDuration } from '@services/utils/dom';
import { CoreUtils } from '@services/utils/utils';
import { Translate } from '@singletons';
import { CoreEventObserver, CoreEvents } from '@singletons/events';
import { AddonModThGlossaryEntriesSource, AddonModThGlossaryEntryItem } from '../../classes/thglossary-entries-source';
import {
    AddonModThGlossary,
    AddonModThGlossaryEntry,
    AddonModThGlossaryThGlossary,
    AddonModThGlossaryProvider,
    GLOSSARY_ENTRY_UPDATED,
} from '../../services/thglossary';
import { CoreTime } from '@singletons/time';
import { CoreAnalytics, CoreAnalyticsEventType } from '@services/analytics';

/**
 * Page that displays a thglossary entry.
 */
@Component({
    selector: 'page-addon-mod-thglossary-entry',
    templateUrl: 'entry.html',
})
export class AddonModThGlossaryEntryPage implements OnInit, OnDestroy {

    @ViewChild(CoreCommentsCommentsComponent) comments?: CoreCommentsCommentsComponent;

    component = AddonModThGlossaryProvider.COMPONENT;
    componentId?: number;
    onlineEntry?: AddonModThGlossaryEntry;
    offlineEntry?: AddonModThGlossaryOfflineEntry;
    offlineEntryFiles?: FileEntry[];
    entries!: AddonModThGlossaryEntryEntriesSwipeManager;
    thglossary?: AddonModThGlossaryThGlossary;
    entryUpdatedObserver?: CoreEventObserver;
    loaded = false;
    showAuthor = false;
    showDate = false;
    ratingInfo?: CoreRatingInfo;
    tagsEnabled = false;
    canEdit = false;
    canDelete = false;
    commentsEnabled = false;
    courseId!: number;
    cmId!: number;

    protected logView: () => void;

    constructor(@Optional() protected splitView: CoreSplitViewComponent, protected route: ActivatedRoute) {
        this.logView = CoreTime.once(async () => {
            if (!this.onlineEntry || !this.thglossary || !this.componentId) {
                return;
            }

            await CoreUtils.ignoreErrors(AddonModThGlossary.logEntryView(this.onlineEntry.id, this.componentId));

            this.analyticsLogEvent('mod_thglossary_get_entry_by_id', `/mod/thglossary/showentry.php?eid=${this.onlineEntry.id}`);
        });
    }

    get entry(): AddonModThGlossaryEntry | AddonModThGlossaryOfflineEntry | undefined {
        return this.onlineEntry ?? this.offlineEntry;
    }

    /**
     * @inheritdoc
     */
    async ngOnInit(): Promise<void> {
        let onlineEntryId: number | null = null;
        let offlineEntryTimeCreated: number | null = null;

        try {
            this.courseId = CoreNavigator.getRequiredRouteNumberParam('courseId');
            this.tagsEnabled = CoreTag.areTagsAvailableInSite();
            this.commentsEnabled = CoreComments.areCommentsEnabledInSite();
            this.cmId = CoreNavigator.getRequiredRouteNumberParam('cmId');

            const entrySlug = CoreNavigator.getRequiredRouteParam<string>('entrySlug');
            const routeData = CoreNavigator.getRouteData(this.route);
            const source = CoreRoutedItemsManagerSourcesTracker.getOrCreateSource(
                AddonModThGlossaryEntriesSource,
                [this.courseId, this.cmId, routeData.thglossaryPathPrefix ?? ''],
            );

            this.entries = new AddonModThGlossaryEntryEntriesSwipeManager(source);

            await this.entries.start();

            if (entrySlug.startsWith('new-')) {
                offlineEntryTimeCreated = Number(entrySlug.slice(4));
            } else {
                onlineEntryId = Number(entrySlug);
            }
        } catch (error) {
            CoreDomUtils.showErrorModal(error);
            CoreNavigator.back();

            return;
        }

        this.entryUpdatedObserver = CoreEvents.on(GLOSSARY_ENTRY_UPDATED, data => {
            if (data.thglossaryId !== this.thglossary?.id) {
                return;
            }

            if (
                (this.onlineEntry && this.onlineEntry.id === data.entryId) ||
                (this.offlineEntry && this.offlineEntry.timecreated === data.timecreated)
            ) {
                this.doRefresh();
            }
        });

        try {
            if (onlineEntryId) {
                await this.loadOnlineEntry(onlineEntryId);
            } else if (offlineEntryTimeCreated) {
                await this.loadOfflineEntry(offlineEntryTimeCreated);
            }
        } finally {
            this.loaded = true;
        }
    }

    /**
     * @inheritdoc
     */
    ngOnDestroy(): void {
        this.entries.destroy();
        this.entryUpdatedObserver?.off();
    }

    /**
     * Edit entry.
     */
    async editEntry(): Promise<void> {
        await CoreNavigator.navigate('./edit');
    }

    /**
     * Delete entry.
     */
    async deleteEntry(): Promise<void> {
        // Log analytics even if the user cancels for consistency with LMS.
        this.analyticsLogEvent(
            'mod_thglossary_delete_entry',
            `/mod/thglossary/deleteentry.php?id=${this.thglossary?.id}&mode=delete&entry=${this.onlineEntry?.id}`,
        );

        const thglossaryId = this.thglossary?.id;
        const cancelled = await CoreUtils.promiseFails(
            CoreDomUtils.showConfirm(Translate.instant('addon.mod_glossary.areyousuredelete')),
        );

        if (!thglossaryId || cancelled) {
            return;
        }

        const modal = await CoreDomUtils.showModalLoading();

        try {
            if (this.onlineEntry) {
                const entryId = this.onlineEntry.id;

                await AddonModThGlossary.deleteEntry(thglossaryId, entryId);
                await Promise.all([
                    CoreUtils.ignoreErrors(AddonModThGlossary.invalidateEntry(entryId)),
                    CoreUtils.ignoreErrors(AddonModThGlossary.invalidateEntriesByLetter(thglossaryId)),
                    CoreUtils.ignoreErrors(AddonModThGlossary.invalidateEntriesByAuthor(thglossaryId)),
                    CoreUtils.ignoreErrors(AddonModThGlossary.invalidateEntriesByCategory(thglossaryId)),
                    CoreUtils.ignoreErrors(AddonModThGlossary.invalidateEntriesByDate(thglossaryId, 'CREATION')),
                    CoreUtils.ignoreErrors(AddonModThGlossary.invalidateEntriesByDate(thglossaryId, 'UPDATE')),
                    CoreUtils.ignoreErrors(this.entries.getSource().invalidateCache(false)),
                ]);
            } else if (this.offlineEntry) {
                const concept = this.offlineEntry.concept;
                const timecreated = this.offlineEntry.timecreated;

                await AddonModThGlossaryOffline.deleteOfflineEntry(thglossaryId, timecreated);
                await AddonModThGlossaryHelper.deleteStoredFiles(thglossaryId, concept, timecreated);
            }

            CoreDomUtils.showToast('addon.mod_glossary.entrydeleted', true, ToastDuration.LONG);

            if (this.splitView?.outletActivated) {
                await CoreNavigator.navigate('../../');
            } else {
                await CoreNavigator.back();
            }
        } catch (error) {
            CoreDomUtils.showErrorModalDefault(error, 'addon.mod_glossary.errordeleting', true);
        } finally {
            modal.dismiss();
        }
    }

    /**
     * Refresh the data.
     *
     * @param refresher Refresher.
     * @returns Promise resolved when done.
     */
    async doRefresh(refresher?: HTMLIonRefresherElement): Promise<void> {
        if (this.onlineEntry && this.thglossary?.allowcomments && this.onlineEntry.id > 0 && this.commentsEnabled && this.comments) {
            // Refresh comments asynchronously (without blocking the current promise).
            CoreUtils.ignoreErrors(this.comments.doRefresh());
        }

        try {
            if (this.onlineEntry) {
                await CoreUtils.ignoreErrors(AddonModThGlossary.invalidateEntry(this.onlineEntry.id));
                await this.loadOnlineEntry(this.onlineEntry.id);
            } else if (this.offlineEntry) {
                const entrySlug = CoreNavigator.getRequiredRouteParam<string>('entrySlug');
                const timecreated = Number(entrySlug.slice(4));

                await this.loadOfflineEntry(timecreated);
            }
        } finally {
            refresher?.complete();
        }
    }

    /**
     * Load online entry data.
     */
    protected async loadOnlineEntry(entryId: number): Promise<void> {
        try {
            const result = await AddonModThGlossary.getEntry(entryId);
            const canDeleteEntries = CoreNetwork.isOnline() && await AddonModThGlossary.canDeleteEntries();
            const canUpdateEntries = CoreNetwork.isOnline() && await AddonModThGlossary.canUpdateEntries();

            this.onlineEntry = result.entry;
            this.ratingInfo = result.ratinginfo;
            this.canDelete = canDeleteEntries && !!result.permissions?.candelete;
            this.canEdit = canUpdateEntries && !!result.permissions?.canupdate;

            await this.loadThGlossary();

            this.logView();
        } catch (error) {
            CoreDomUtils.showErrorModalDefault(error, 'addon.mod_glossary.errorloadingentry', true);
        }
    }

    /**
     * Load offline entry data.
     *
     * @param timecreated Entry Timecreated.
     */
    protected async loadOfflineEntry(timecreated: number): Promise<void> {
        try {
            const thglossary = await this.loadThGlossary();

            this.offlineEntry = await AddonModThGlossaryOffline.getOfflineEntry(thglossary.id, timecreated);
            this.offlineEntryFiles = this.offlineEntry.attachments && this.offlineEntry.attachments.offline > 0
                ? await AddonModThGlossaryHelper.getStoredFiles(
                    thglossary.id,
                    this.offlineEntry.concept,
                    timecreated,
                )
                : undefined;
            this.canEdit = true;
            this.canDelete = true;
        } catch (error) {
            CoreDomUtils.showErrorModalDefault(error, 'addon.mod_glossary.errorloadingentry', true);
        }
    }

    /**
     * Load thglossary data.
     *
     * @returns ThGlossary.
     */
    protected async loadThGlossary(): Promise<AddonModThGlossaryThGlossary> {
        if (this.thglossary) {
            return this.thglossary;
        }

        this.thglossary = await AddonModThGlossary.getThGlossary(this.courseId, this.cmId);
        this.componentId = this.thglossary.coursemodule;

        switch (this.thglossary.displayformat) {
            case 'fullwithauthor':
            case 'encyclopedia':
                this.showAuthor = true;
                this.showDate = true;
                break;
            case 'fullwithoutauthor':
                this.showAuthor = false;
                this.showDate = true;
                break;
            default: // Default, and faq, simple, entrylist, continuous.
                this.showAuthor = false;
                this.showDate = false;
        }

        return this.thglossary;
    }

    /**
     * Function called when rating is updated online.
     */
    ratingUpdated(): void {
        if (!this.onlineEntry) {
            return;
        }

        AddonModThGlossary.invalidateEntry(this.onlineEntry.id);
    }

    /**
     * Log analytics event.
     *
     * @param wsName WS name.
     * @param url URL.
     */
    protected analyticsLogEvent(wsName: string, url: string): void {
        if (!this.onlineEntry || !this.thglossary) {
            return;
        }

        CoreAnalytics.logEvent({
            type: CoreAnalyticsEventType.VIEW_ITEM,
            ws: wsName,
            name: this.onlineEntry.concept,
            data: { id: this.onlineEntry.id, thglossaryid: this.thglossary.id, category: 'thglossary' },
            url,
        });
    }

}

/**
 * Helper to manage swiping within a collection of thglossary entries.
 */
class AddonModThGlossaryEntryEntriesSwipeManager
    extends CoreSwipeNavigationItemsManager<AddonModThGlossaryEntryItem, AddonModThGlossaryEntriesSource> {

    /**
     * @inheritdoc
     */
    protected getSelectedItemPathFromRoute(route: ActivatedRouteSnapshot | ActivatedRoute): string | null {
        const params = CoreNavigator.getRouteParams(route);

        return `${this.getSource().GLOSSARY_PATH_PREFIX}entry/${params.entrySlug}`;
    }

}
