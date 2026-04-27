import * as React from "react";
import { LucideIcon, IconActionButton } from "./IconButton";
import type { AttachedFile } from "../../types/chat";

interface AttachmentStripProps {
	files: AttachedFile[];
	onRemove: (id: string) => void;
}

/**
 * Horizontal strip of attachment previews with remove buttons.
 * - Images: show thumbnail
 * - Files: show file icon with filename
 */
export function AttachmentStrip({ files, onRemove }: AttachmentStripProps) {
	if (files.length === 0) return null;

	return (
		<div className="agent-client-attachment-preview-strip">
			{files.map((file) => (
				<div
					key={file.id}
					className="agent-client-attachment-preview-item"
				>
					{file.kind === "image" && file.data ? (
						<img
							src={`data:${file.mimeType};base64,${file.data}`}
							alt="Attached image"
							className="agent-client-attachment-preview-thumbnail"
						/>
					) : (
						<div className="agent-client-attachment-preview-file">
							<LucideIcon
								name="file"
								className="agent-client-attachment-preview-file-icon"
							/>
							<span className="agent-client-attachment-preview-file-name">
								{file.name ?? "file"}
							</span>
						</div>
					)}
					<IconActionButton
						className="agent-client-attachment-preview-remove"
						iconName="x"
						title="Remove attachment"
						ariaLabel="Remove attachment"
						onClick={() => onRemove(file.id)}
					/>
				</div>
			))}
		</div>
	);
}
