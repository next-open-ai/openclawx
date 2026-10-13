<script setup lang="ts">
import DocumentAttachments from '../chat/DocumentAttachments.vue';
import { uploadWorkflowDocument } from '../../services/orchestration';
const props = defineProps<{ workflowId: string; requestId: string; disabled: boolean }>();
const emit = defineEmits<{ change: [fileIds: string[]]; uploading: [value: boolean]; valid: [value: boolean] }>();
</script>
<template>
  <DocumentAttachments :disabled="disabled" :upload-file="file => uploadWorkflowDocument(props.workflowId, props.requestId, file)" @change="emit('change', $event)" @uploading="emit('uploading', $event)" @valid="emit('valid', $event)" />
</template>
