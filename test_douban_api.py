import requests
import urllib.parse
import time
import random

USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
]

def get_random_user_agent():
    return random.choice(USER_AGENTS)

def test_api_call(session, type_param, tag_param, sort_param='recommend'):
    base_url = 'https://movie.douban.com/j/search_subjects'
    encoded_tag = urllib.parse.quote(tag_param)
    url = f"{base_url}?type={type_param}&tag={encoded_tag}&sort={sort_param}&page_limit=1&page_start=0"
    
    print(f"\nTesting URL: {url}")
    headers = {
        'User-Agent': get_random_user_agent(),
        'Referer': 'https://movie.douban.com/',
        'Accept': 'application/json, text/plain, */*',
    }

    try:
        response = session.get(url, headers=headers, timeout=10)
        if response.status_code != 200:
            print(f"  => HTTP Error: {response.status_code} for tag \"{tag_param}\" (type: {type_param})")
            return {'type': type_param, 'tag': tag_param, 'sort': sort_param, 'status': f'HTTP Error {response.status_code}', 'count': 0, 'url': url}
        
        try:
            data = response.json()
            if data.get('subjects') and len(data['subjects']) > 0:
                print(f"  => OK: Found {len(data['subjects'])} result(s) for tag \"{tag_param}\" (type: {type_param})")
                return {'type': type_param, 'tag': tag_param, 'sort': sort_param, 'status': 'OK', 'count': len(data['subjects']), 'url': url}
            else:
                print(f"  => No Results: for tag \"{tag_param}\" (type: {type_param})")
                return {'type': type_param, 'tag': tag_param, 'sort': sort_param, 'status': 'No Results', 'count': 0, 'url': url}
        except requests.exceptions.JSONDecodeError:
            print(f"  => JSON Parse Error for tag \"{tag_param}\" (type: {type_param}). Response text: {response.text[:200]}...")
            return {'type': type_param, 'tag': tag_param, 'sort': sort_param, 'status': 'JSON Parse Error', 'count': 0, 'url': url}

    except requests.exceptions.RequestException as e:
        print(f"  => Request Error: {e} for tag \"{tag_param}\" (type: {type_param})")
        return {'type': type_param, 'tag': tag_param, 'sort': sort_param, 'status': f'Request Error: {e}', 'count': 0, 'url': url}

def run_tests():
    print('Starting Old Douban API Tests (Python Script)...\n')
    test_results = []
    session = requests.Session() # Use a session for potential connection reuse

    api_types = ['movie', 'tv']
    
    primary_content_tags = ['电影', '电视剧', '动画', '综艺', '纪录片', '短片']
    genre_tags = ['喜剧', '爱情', '动作', '科幻', '悬疑', '恐怖', '剧情', '战争', '奇幻', '冒险', '犯罪', '惊悚', '家庭', '古装', '武侠', '音乐', '歌舞', '传记', '历史', '西部', '黑色电影', '情色', '灾难', '儿童']
    region_tags = ['中国大陆', '美国', '香港', '台湾', '日本', '韩国', '英国', '法国', '德国', '意大利', '西班牙', '印度', '泰国', '俄罗斯', '加拿大', '澳大利亚', '爱尔兰', '瑞典', '巴西', '丹麦', '内地', '内地剧', '大陆', '港台']
    descriptive_tags = ['热门', '最新', '经典', '豆瓣高分', '冷门佳片', '华语', '欧美']

    all_unique_tags = list(set(primary_content_tags + genre_tags + region_tags + descriptive_tags))

    for type_param in api_types:
        print(f"\n--- Testing All Unique Tags with type=\"{type_param}\" ---")
        for tag_param in all_unique_tags:
            # Heuristic to skip obviously mismatched primary content tags and types
            if type_param == 'movie' and (tag_param in ['电视剧', '综艺', '内地剧']):
                continue
            if type_param == 'tv' and (tag_param in ['电影', '短片'] and tag_param != '动画'): # Allow '动画' for tv
                 if tag_param == '动画' and type_param == 'tv': # Specifically test tv + 动画
                    pass # Allow this combination
                 else:
                    continue


            test_results.append(test_api_call(session, type_param, tag_param))
            time.sleep(0.2) # Small delay between requests to be polite

    print('\n\n--- Test Run Complete. Summary: ---')
    successful_combinations = 0
    ok_results = []
    no_results_list = []
    error_results = []

    for r in test_results:
        if r['status'] == 'OK':
            successful_combinations += 1
            ok_results.append(f"✅ Type: {r['type']:<6}, Tag: \"{r['tag']:<10}\", Status: {r['status']:<12}, Count: {r['count']}")
        elif r['status'] == 'No Results':
            no_results_list.append(f"⚠️ Type: {r['type']:<6}, Tag: \"{r['tag']:<10}\", Status: {r['status']:<20}, URL: {r['url']}")
        else:
            error_results.append(f"❌ Type: {r['type']:<6}, Tag: \"{r['tag']:<10}\", Status: {r['status']:<20}, URL: {r['url']}")
    
    print("\n--- Successful Combinations (Found Results): ---")
    for res_str in ok_results:
        print(res_str)
    
    if no_results_list:
        print("\n--- Combinations with No Results: ---")
        for res_str in no_results_list:
            print(res_str)
            
    if error_results:
        print("\n--- Combinations with Errors: ---")
        for res_str in error_results:
            print(res_str)

    print(f"\nTotal tests run: {len(test_results)}")
    print(f"Successful combinations (found results): {successful_combinations}")
    print('Done.')

if __name__ == '__main__':
    run_tests()
