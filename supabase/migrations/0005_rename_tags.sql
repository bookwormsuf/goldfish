-- Rename "topic" to "tag" throughout, per user request. Pure renames, no
-- data loss — confirmed live beforehand: 0 sent_messages rows, 0
-- user-created tags, so nothing needs backfilling. See SPEC.md and
-- STATUS.md's Step 9 entry for the full account.

alter table topics rename to tags;
alter table article_topics rename to article_tags;
alter table article_tags rename column topic_id to tag_id;
alter index article_topics_topic_idx rename to article_tags_tag_idx;

alter table sent_messages drop constraint sent_messages_kind_check;
alter table sent_messages add constraint sent_messages_kind_check
  check (kind in ('article', 'tag_list'));
update sent_messages set kind = 'tag_list' where kind = 'topic_list';
