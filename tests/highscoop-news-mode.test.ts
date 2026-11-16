import { expect,it } from "vitest";
import { channelCollectionKind,channelDiscoverySettings } from "../shared/channelContentMode";
import { contentTemplateForItem } from "../shared/channelEditorial";
it("keeps admissions and news as separate modes of one brand",()=>{
  const channel={slug:"opportunities",contentType:"notice",cardTemplate:"highscoop:gifted"};
  expect(channelCollectionKind(channel,"뉴스")).toBe("current_dialogue");
  expect(channelCollectionKind(channel,"중등입시")).toBe("notice");
  expect(channelDiscoverySettings(channel)?.enabled).toBe(false);
  expect(contentTemplateForItem(channel,{kind:"current_dialogue",subcategory:"뉴스"})).toBe("set:n03");
  expect(contentTemplateForItem(channel,{kind:"notice"})).toBe("highscoop:gifted");
  expect(contentTemplateForItem(channel,{kind:"current_dialogue",cardCopy:{templateKey:"set:n09"}})).toBe("set:n09");
  expect(contentTemplateForItem(channel,{kind:"current_dialogue"},"set:n10")).toBe("set:n10");
});
